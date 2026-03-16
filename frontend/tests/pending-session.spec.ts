/**
 * PS-01  Title on send           — first-message title row appears in sidebar immediately after pressing Enter
 * PS-02  New Chat while streaming — title row stays in sidebar with pulsing indicator; composer blank
 * PS-03  done replaces title      — loadHistory response swaps user-message title for real session title
 * PS-04  Click title row          — navigates back to show in-progress messages
 * PS-05  POST /chat error         — error rendered, composer re-enables
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, makeSession, sse } from "./helpers/setup";

test.describe("pending-session", () => {
  test("PS-01 title appears in sidebar immediately on send", async ({ page }) => {
    await setupApp(page, {});

    // Send but do NOT resolve SSE yet — title must appear before any events arrive
    await sendMessage(page, "Hello Claude");

    await expect(page.locator("span.truncate").filter({ hasText: "Hello Claude" })).toBeVisible();
  });

  test("PS-02 clicking New Chat while streaming keeps title row with pulsing indicator", async ({ page }) => {
    await setupApp(page, {});

    await sendMessage(page, "Hello Claude");

    // Title visible immediately
    await expect(page.locator("span.truncate").filter({ hasText: "Hello Claude" })).toBeVisible();

    // Click New Chat mid-stream
    await page.getByRole("button", { name: "New Chat" }).click();

    // Blank state shown (new chat view)
    await expect(page.getByText("Start a new conversation")).toBeVisible();

    // Title still in sidebar
    await expect(page.locator("span.truncate").filter({ hasText: "Hello Claude" })).toBeVisible();

    // Pulsing indicator visible on the title row
    await expect(page.locator(".animate-ping")).toBeVisible();
  });

  test("PS-03 done event replaces user-message title with real session title", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");

    await expect(page.locator("span.truncate").filter({ hasText: "Hello" })).toBeVisible();

    ctrl.setSessions([makeSession({ session_id: "sess-1", title: "Hello session" })]);
    ctrl.sendSseEvents(sse.text("Hi there!", "sess-1"));

    // Real session title should replace the user-message title
    await expect(page.locator("span.truncate").filter({ hasText: "Hello session" })).toBeVisible();
    await expect(page.locator("span.truncate").filter({ hasText: /^Hello$/ })).not.toBeVisible();
  });

  test("PS-04 clicking title row while streaming shows in-progress messages", async ({ page }) => {
    await setupApp(page, {});

    await sendMessage(page, "Hello Claude");

    // Switch away via New Chat
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByText("Start a new conversation")).toBeVisible();

    // Click the title row to navigate back
    await page.locator("span.truncate").filter({ hasText: "Hello Claude" }).click();

    // Original message should be visible again
    await expect(page.getByRole("main").getByText("Hello Claude")).toBeVisible();
  });

  test("PS-05 POST /chat error: error shown, composer re-enables", async ({ page }) => {
    await setupApp(page, { chatError: "Service unavailable" });

    await sendMessage(page, "Hello");

    // Wait for the error to appear
    await expect(page.getByText("Service unavailable")).toBeVisible();

    // Composer should be usable (not disabled)
    await expect(page.getByPlaceholder("Message Claude\u2026")).toBeEnabled();
  });
});
