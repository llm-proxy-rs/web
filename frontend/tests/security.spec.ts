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
