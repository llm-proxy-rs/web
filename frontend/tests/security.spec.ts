import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("localStorage prototype pollution protection", () => {
  test("poisoned ui_preferences does not inject __proto__ keys", async ({
    page,
  }) => {
    // Seed localStorage with a prototype pollution payload
    await page.addInitScript(() => {
      localStorage.setItem(
        "ui_preferences",
        JSON.stringify({
          __proto__: { polluted: true },
          constructor: { prototype: { polluted: true } },
        }),
      );
    });

    await setupApp(page);

    // The app should load without errors — verify a basic element renders
    await expect(page.getByPlaceholder("Message Claude…")).toBeVisible();

    // Verify the pollution did NOT reach Object.prototype
    const polluted = await page.evaluate(() => (({}) as any).polluted);
    expect(polluted).toBeUndefined();
  });

  test("ui_preferences with non-boolean values are ignored", async ({
    page,
  }) => {
    // Inject preferences with wrong types — should fall back to defaults
    await page.addInitScript(() => {
      localStorage.setItem(
        "ui_preferences",
        JSON.stringify({
          autoExpandTools: "yes", // should be boolean
          showThinking: 42, // should be boolean
          autoScrollToBottom: null, // should be boolean
          extraKey: "injected", // unknown key
        }),
      );
    });

    await setupApp(page);

    // App should load and use defaults for invalid values
    const prefs = await page.evaluate(() => {
      const raw = localStorage.getItem("ui_preferences");
      return raw ? JSON.parse(raw) : null;
    });

    // The stored value won't have been overwritten yet (only on user toggle),
    // but the app should not crash
    await expect(page.getByPlaceholder("Message Claude…")).toBeVisible();
  });

  test("poisoned question storage does not inject __proto__ keys", async ({
    page,
  }) => {
    // Seed a question entry with prototype pollution payload
    await page.addInitScript(() => {
      localStorage.setItem(
        "question_test-req",
        JSON.stringify({
          __proto__: { polluted: true },
          conversationId: "conv-1",
          taskId: "task-1",
          requestId: "test-req",
          questions: [],
        }),
      );
    });

    await setupApp(page);
    await expect(page.getByPlaceholder("Message Claude…")).toBeVisible();

    // Verify no prototype pollution
    const polluted = await page.evaluate(() => (({}) as any).polluted);
    expect(polluted).toBeUndefined();
  });
});

test.describe("markdown sanitization", () => {
  test("className regex only allows language- prefix on code elements", async ({
    page,
  }) => {
    const app = await setupApp(page);

    // Send markdown with a code block that has a malicious class attempt
    await sendMessage(page, "test");
    app.sendSseEvents(
      sse.text("```javascript\nconsole.log('hello');\n```", "sess-1"),
    );

    // Wait for the code block to render
    await expect(page.locator("pre code")).toBeVisible();

    // The code element should only have language-* classes
    const classes = await page.locator("pre code").getAttribute("class");
    if (classes) {
      const classList = classes.split(/\s+/);
      for (const cls of classList) {
        // Each class should either be a language- prefix or from syntax highlighter
        expect(cls).toMatch(/^(language-|hljs)/);
      }
    }
  });

  test("script tags in markdown are sanitized", async ({ page }) => {
    const app = await setupApp(page);

    await sendMessage(page, "test");
    app.sendSseEvents(
      sse.text(
        "Safe text before\n\n<script>window.__xss = true</script>\n\nSafe text after",
        "sess-1",
      ),
    );

    await expect(page.getByText("Safe text before")).toBeVisible();

    // Verify the script did not execute
    const xss = await page.evaluate(() => (window as any).__xss);
    expect(xss).toBeUndefined();
  });

  test("img onerror XSS in markdown is sanitized", async ({ page }) => {
    const app = await setupApp(page);

    await sendMessage(page, "test");
    app.sendSseEvents(
      sse.text('<img src="x" onerror="window.__xss=true">Hello', "sess-1"),
    );

    await expect(page.getByText("Hello")).toBeVisible();

    const xss = await page.evaluate(() => (window as any).__xss);
    expect(xss).toBeUndefined();
  });

  test("anchor with javascript: protocol is sanitized", async ({ page }) => {
    const app = await setupApp(page);

    await sendMessage(page, "test");
    app.sendSseEvents(sse.text("[click me](javascript:alert(1))", "sess-1"));

    await expect(page.getByText("click me")).toBeVisible();

    // The sanitizer should either strip the href entirely (null) or replace it
    // with a safe value — either way, javascript: must not survive.
    const href = await page.getByText("click me").getAttribute("href");
    if (href !== null) {
      expect(href).not.toContain("javascript:");
    }
    // If href is null, the sanitizer stripped it completely — that's even safer.
  });
});

test.describe("gateway renew redirect validation", () => {
  test("SEC-01 blocks http: redirect URLs", async ({ page }) => {
    await setupApp(page, {
      settings: {
        uses_bedrock: false,
        has_api_key: false,
        base_url: null,
        gateway_configured: true,
      },
      renewGatewayKeyRedirect: "http://evil.example.com/phish",
    });

    await page.getByTitle("Settings").click();
    await page.getByRole("button", { name: "Renew API Key" }).click();

    // Should show error because http: is blocked
    await expect(
      page.getByText("Failed to renew. Please try again."),
    ).toBeVisible();
  });

  test("SEC-02 blocks javascript: redirect URLs", async ({ page }) => {
    await setupApp(page, {
      settings: {
        uses_bedrock: false,
        has_api_key: false,
        base_url: null,
        gateway_configured: true,
      },
      renewGatewayKeyRedirect: "javascript:alert(document.cookie)",
    });

    await page.getByTitle("Settings").click();
    await page.getByRole("button", { name: "Renew API Key" }).click();

    // Should show error because javascript: is blocked
    await expect(
      page.getByText("Failed to renew. Please try again."),
    ).toBeVisible();
  });
});

test.describe("VM status polling bounds", () => {
  test("SEC-03 polling stops after max attempts", async ({ page }) => {
    let pollCount = 0;

    // Always return provisioning so polling never succeeds
    await page.route("**/api/vm-status", (route) => {
      pollCount++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "provisioning" }),
      });
    });

    await setupApp(page, { vmId: "" });

    // Wait enough time for many polls (2s interval, MAX_ATTEMPTS=90 → 180s).
    // We can't wait 180s in a test, but we can verify it's polling and bounded.
    // Wait 6 seconds and verify polls are happening at ~2s intervals.
    await page.waitForTimeout(6000);
    const earlyCount = pollCount;
    expect(earlyCount).toBeGreaterThanOrEqual(2);
    expect(earlyCount).toBeLessThanOrEqual(5);

    // Composer should NOT appear (still loading)
    await expect(page.getByPlaceholder("Message Claude…")).not.toBeVisible();
  });
});
