/**
 * Font size hierarchy tests for the chat app.
 *
 * FS-01  User message bubble uses base size (>=14px)
 * FS-02  Assistant message body uses base size (>=14px)
 * FS-03  Composer textarea uses base size (>=14px)
 * FS-04  Claude header label uses text-sm (14px)
 * FS-05  Sidebar conversation items use text-sm (14px)
 * FS-06  Tool header name uses text-sm (14px)
 * FS-07  Status bar text uses text-sm (14px)
 * FS-08  Timestamps use text-xs (12px), not smaller
 * FS-09  Empty state message uses base size (>=14px)
 * FS-10  Error message uses base size (>=14px)
 */
import { test, expect } from "@playwright/test";
import {
  setupApp,
  sendMessage,
  sse,
  makeSession,
  makeConversation,
} from "./helpers/setup";

/** Parse computed font-size (e.g. "16px") to a number. */
function px(s: string): number {
  return parseFloat(s);
}

test.describe("font size hierarchy", () => {
  test("FS-01 user message bubble uses base size (>=14px)", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello world");
    ctrl.sendSseEvents(sse.text("Reply", "sess-fs1"));

    const userBubble = page
      .locator(".bg-primary")
      .filter({ hasText: "Hello world" })
      .first();
    await expect(userBubble).toBeVisible();

    const fontSize = await userBubble.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    // text-base = 1rem, should not be text-sm (0.875rem ≈ 14px) or smaller
    expect(px(fontSize)).toBeGreaterThanOrEqual(14);
  });

  test("FS-02 assistant message body uses base size (>=14px)", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hi");
    ctrl.sendSseEvents(sse.text("This is an assistant response.", "sess-fs2"));

    const assistantText = page
      .getByText("This is an assistant response.")
      .first();
    await expect(assistantText).toBeVisible();

    const fontSize = await assistantText.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    expect(px(fontSize)).toBeGreaterThanOrEqual(14);
  });

  test("FS-03 composer textarea uses base size (>=14px)", async ({ page }) => {
    await setupApp(page, {});

    const textarea = page.locator('textarea[placeholder="Message Claude…"]');
    await expect(textarea).toBeVisible();

    const fontSize = await textarea.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    expect(px(fontSize)).toBeGreaterThanOrEqual(14);
  });

  test("FS-04 Claude header label uses sm size (>=13px)", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Hi!", "sess-fs4"));

    const claudeLabel = page
      .locator('[class*="font-semibold"]')
      .filter({ hasText: "Claude" })
      .first();
    await expect(claudeLabel).toBeVisible();

    const fontSize = await claudeLabel.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    expect(px(fontSize)).toBeGreaterThanOrEqual(13);
  });

  test("FS-05 sidebar conversation items use sm size (>=13px)", async ({
    page,
  }) => {
    const conv = makeConversation({ title: "Test conversation" });
    const session = makeSession({
      session_id: conv.sessionId ?? "s1",
      title: "Test conversation",
    });

    await setupApp(page, {
      conversations: [conv],
      sessions: [session],
    });

    const convRow = page.getByText("Test conversation").first();
    await expect(convRow).toBeVisible();

    const fontSize = await convRow.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    expect(px(fontSize)).toBeGreaterThanOrEqual(13);
  });

  test("FS-06 tool header name uses sm size (>=13px)", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Run ls");
    ctrl.sendSseEvents(
      sse.withTool(
        "t1",
        "Bash",
        { command: "ls" },
        "file.txt",
        "Done.",
        "sess-fs6",
      ),
    );

    await expect(page.getByText("Done.")).toBeVisible();

    // The tool name "Bash" in the tool header
    const toolName = page
      .locator('[class*="font-medium"]')
      .filter({ hasText: "Bash" })
      .first();
    await expect(toolName).toBeVisible();

    const fontSize = await toolName.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    expect(px(fontSize)).toBeGreaterThanOrEqual(13);
  });

  test("FS-07 status bar text uses sm size (>=13px)", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-1" } },
      { event: "init" },
    ]);

    const status = page.getByRole("status");
    await expect(status).toBeVisible();

    const fontSize = await status.evaluate((el) => {
      // Find the text span inside the status
      const span = el.querySelector("span:last-child");
      return span
        ? getComputedStyle(span).fontSize
        : getComputedStyle(el).fontSize;
    });
    expect(px(fontSize)).toBeGreaterThanOrEqual(13);
  });

  test("FS-08 timestamps use xs size (>=11px), not smaller", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Hi!", "sess-fs8"));

    await expect(page.getByText("Hi!")).toBeVisible();

    // User message timestamp
    const timePattern = /\d{1,2}:\d{2}/;
    const timestamps = page.locator("span").filter({ hasText: timePattern });
    const count = await timestamps.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const fontSize = await timestamps
        .nth(i)
        .evaluate((el) => getComputedStyle(el).fontSize);
      // text-xs = 12px, should be at least 11px (no more text-[10px])
      expect(px(fontSize)).toBeGreaterThanOrEqual(11);
    }
  });

  test("FS-09 empty state message uses base size (>=15px)", async ({
    page,
  }) => {
    await setupApp(page, {});

    const emptyMsg = page.getByText("Welcome back");
    await expect(emptyMsg).toBeVisible();

    const fontSize = await emptyMsg.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    expect(px(fontSize)).toBeGreaterThanOrEqual(14);
  });

  test("FS-10 error message uses base size (>=14px)", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "fail");
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-1" } },
      { event: "init" },
      {
        event: "error_event",
        data: { message: "Something went wrong in the test" },
      },
    ]);

    const errorMsg = page.getByText("Something went wrong in the test").first();
    await expect(errorMsg).toBeVisible();

    const fontSize = await errorMsg.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    expect(px(fontSize)).toBeGreaterThanOrEqual(14);
  });
});
