/**
 * QS-01  Settings panel contains Quick Settings section
 * QS-02  Toggling "Auto-scroll to bottom" persists to localStorage
 * QS-03  Closing settings panel hides quick settings
 * QS-04  Toggle states restored from localStorage on reload
 * QS-05  Toggling "Show thinking" off hides thinking blocks
 * QS-06  Toggling "Auto-expand tools" on expands tool cards by default
 */
import { test, expect } from "@playwright/test";
import { setupApp, sse, sendMessage } from "./helpers/setup";

test.describe("quick settings", () => {
  test("QS-01 settings panel contains Preferences tab with toggles", async ({
    page,
  }) => {
    await setupApp(page, {});

    await page.getByTitle("Settings").click();

    await expect(
      page.getByRole("button", { name: "Preferences" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Preferences" }).click();
    await expect(page.getByText("Auto-scroll")).toBeVisible();
  });

  test("QS-02 toggling auto-scroll persists to localStorage", async ({
    page,
  }) => {
    await setupApp(page, {});

    await page.getByTitle("Settings").click();
    await page.getByRole("button", { name: "Preferences" }).click();

    // Click the auto-scroll toggle
    const toggle = page
      .locator("label")
      .filter({ hasText: "Auto-scroll" })
      .locator("button[role='switch']");
    await toggle.click();

    // Check localStorage
    const prefs = await page.evaluate(() =>
      localStorage.getItem("ui_preferences"),
    );
    const parsed = JSON.parse(prefs!);
    expect(parsed.autoScrollToBottom).toBe(false);
  });

  test("QS-03 closing settings panel hides preferences", async ({ page }) => {
    await setupApp(page, {});

    await page.getByTitle("Settings").click();
    await page.getByRole("button", { name: "Preferences" }).click();
    await expect(page.getByText("Auto-scroll")).toBeVisible();

    // Click the close button
    await page
      .getByRole("button", { name: /close/i })
      .or(
        page
          .locator("button")
          .filter({ has: page.locator("svg.lucide-x") })
          .first(),
      )
      .click();
    await expect(page.getByText("Auto-scroll")).not.toBeVisible();
  });

  test("QS-04 toggle states restored from localStorage on reload", async ({
    page,
  }) => {
    // Pre-seed localStorage
    await page.addInitScript(() => {
      localStorage.setItem(
        "ui_preferences",
        JSON.stringify({
          autoExpandTools: true,
          showThinking: false,
          autoScrollToBottom: true,
        }),
      );
    });

    await setupApp(page, {});

    await page.getByTitle("Settings").click();
    await page.getByRole("button", { name: "Preferences" }).click();

    // Auto-expand tools should be on
    const expandToggle = page
      .locator("label")
      .filter({ hasText: "Auto-expand tools" })
      .locator("button[role='switch']");
    await expect(expandToggle).toHaveAttribute("aria-checked", "true");

    // Show thinking should be off
    const thinkingToggle = page
      .locator("label")
      .filter({ hasText: "Show thinking" })
      .locator("button[role='switch']");
    await expect(thinkingToggle).toHaveAttribute("aria-checked", "false");

    // Auto-scroll should be on
    const scrollToggle = page
      .locator("label")
      .filter({ hasText: "Auto-scroll" })
      .locator("button[role='switch']");
    await expect(scrollToggle).toHaveAttribute("aria-checked", "true");
  });

  test("QS-05 toggling show thinking off hides thinking blocks", async ({
    page,
  }) => {
    // Pre-seed showThinking = false
    await page.addInitScript(() => {
      localStorage.setItem(
        "ui_preferences",
        JSON.stringify({
          autoExpandTools: false,
          showThinking: false,
          autoScrollToBottom: false,
        }),
      );
    });

    const app = await setupApp(page, {});

    // Send a message that includes thinking
    app.sendSseEvents(sse.withThinking("I am thinking...", "Hello!", "sess-1"));
    await sendMessage(page, "hi");

    // Wait for the assistant reply
    await expect(page.getByText("Hello!")).toBeVisible();

    // Thinking block should NOT be visible
    await expect(page.getByText("Thinking")).not.toBeVisible();
  });

  test("QS-06 toggling auto-expand tools on expands tool cards by default", async ({
    page,
  }) => {
    // Pre-seed autoExpandTools = true
    await page.addInitScript(() => {
      localStorage.setItem(
        "ui_preferences",
        JSON.stringify({
          autoExpandTools: true,
          showThinking: false,
          autoScrollToBottom: false,
        }),
      );
    });

    const app = await setupApp(page, {});

    // Send a message with a tool use (Bash)
    app.sendSseEvents(
      sse.withTool(
        "tool-1",
        "Bash",
        { command: "ls -la" },
        "file1.txt\nfile2.txt",
        "Done!",
        "sess-2",
      ),
    );
    await sendMessage(page, "list files");

    // Wait for the assistant reply
    await expect(page.getByText("Done!")).toBeVisible();

    // The tool card should be expanded (showing the command content inside <pre>)
    await expect(
      page.locator("pre").filter({ hasText: "ls -la" }),
    ).toBeVisible();
  });
});
