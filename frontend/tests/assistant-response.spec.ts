/**
 * Tests for assistant response UI improvements:
 * - Status indicator reflects real SSE phase (thinking/responding/using tools)
 * - Status indicator stays above the message input (not inside scroll area)
 * - All assistant messages grouped under one Claude header
 * - Markdown rendering quality
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse, type SseEvent } from "./helpers/setup";

test.describe("assistant response - status indicator phases", () => {
  test("shows 'Thinking' status during init/thinking phase", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Hello");

    // Send only init + thinking (no text_delta yet) to keep it in thinking phase
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-1" } },
      { event: "init" },
      { event: "thinking_delta", data: { thinking: "Let me think..." } },
    ]);

    // Should show "Thinking" status text
    await expect(page.getByRole("status")).toContainText("Thinking");
  });

  test("shows 'Responding' status when text_delta arrives", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-1" } },
      { event: "init" },
      { event: "text_delta", data: { text: "Hello! " } },
    ]);

    await expect(page.getByRole("status")).toContainText("Responding");
  });

  test("shows tool name in status when tool_start arrives", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Run something");
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-1" } },
      { event: "init" },
      {
        event: "tool_start",
        data: { id: "t1", name: "Bash", input: { command: "ls" } },
      },
    ]);

    await expect(page.getByRole("status")).toContainText("Bash");
  });

  test("status disappears after done event", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Hi there!", "sess-1"));

    await expect(page.getByText("Hi there!")).toBeVisible();
    // Status should be gone
    await expect(page.getByRole("status")).not.toBeVisible();
  });

  test("status returns to Thinking after tool completes and before next text", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Run ls then tell me");
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-1" } },
      { event: "init" },
      {
        event: "tool_start",
        data: { id: "t1", name: "Bash", input: { command: "ls" } },
      },
      {
        event: "tool_result",
        data: { tool_use_id: "t1", content: "file.txt", is_error: false },
      },
      // After tool_result and before next text_delta, should go back to thinking
    ]);

    // After tool_result, phase goes back to thinking
    await expect(page.getByRole("status")).toContainText("Thinking");
  });
});

test.describe("assistant response - status position", () => {
  test("status indicator appears above the composer, not inside message scroll area", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-1" } },
      { event: "init" },
    ]);

    const status = page.getByRole("status");
    await expect(status).toBeVisible();

    // The status should be positioned after the messages pane and before the composer
    // Verify it's outside the scroll container by checking it's a sibling of the composer area
    const statusBox = await status.boundingBox();
    const composer = page.locator(
      'textarea[placeholder="Message Claude…"], textarea[placeholder^="Type to queue"]',
    );
    const composerBox = await composer.boundingBox();

    // Status should be above the composer
    expect(statusBox!.y).toBeLessThan(composerBox!.y);
  });
});

test.describe("assistant response - message grouping", () => {
  test("assistant text after tool use does not show a second Claude header", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Run ls");
    ctrl.sendSseEvents(
      sse.withTool(
        "t1",
        "Bash",
        { command: "ls" },
        "file.txt",
        "Here are the files.",
        "sess-1",
      ),
    );

    await expect(page.getByText("Here are the files.")).toBeVisible();

    // There should be only ONE Claude header/avatar for the entire assistant response
    const claudeHeaders = page
      .locator("text=Claude")
      .filter({ has: page.locator("xpath=..") });
    // The "Claude" label in the header
    const headerLabels = page
      .locator('[class*="font-semibold"]')
      .filter({ hasText: "Claude" });
    const count = await headerLabels.count();
    expect(count).toBe(1);
  });

  test("multiple text chunks in one response stay under single Claude header", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Explain something");
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-1" } },
      { event: "init" },
      { event: "text_delta", data: { text: "First part. " } },
      { event: "text_delta", data: { text: "Second part." } },
      { event: "done", data: { session_id: "sess-1", task_id: "task-1" } },
    ]);

    await expect(page.getByText("First part. Second part.")).toBeVisible();

    const headerLabels = page
      .locator('[class*="font-semibold"]')
      .filter({ hasText: "Claude" });
    const count = await headerLabels.count();
    expect(count).toBe(1);
  });
});

test.describe("assistant response - markdown quality", () => {
  test("code blocks render with proper styling", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Show code");
    ctrl.sendSseEvents(
      sse.text(
        "Here is some code:\n\n```javascript\nconst x = 42;\nconsole.log(x);\n```",
        "sess-1",
      ),
    );

    // Code block header shows language
    await expect(page.getByText("javascript")).toBeVisible();
    // Code content is visible
    await expect(page.getByText("const x = 42;")).toBeVisible();
    // Copy button exists
    await expect(page.getByTitle("Copy code")).toBeVisible();
  });

  test("lists render properly with correct spacing", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Give me a list");
    ctrl.sendSseEvents(
      sse.text(
        "Here are items:\n\n- First item\n- Second item\n- Third item",
        "sess-1",
      ),
    );

    await expect(page.getByText("First item")).toBeVisible();
    await expect(page.getByText("Second item")).toBeVisible();
    await expect(page.getByText("Third item")).toBeVisible();

    // Should render as actual list items
    const listItems = page.locator("li").filter({ hasText: /item/ });
    expect(await listItems.count()).toBe(3);
  });

  test("inline code renders with background styling", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Tell me about code");
    ctrl.sendSseEvents(
      sse.text("Use the `console.log` function to debug.", "sess-1"),
    );

    const inlineCode = page.locator("code").filter({ hasText: "console.log" });
    await expect(inlineCode).toBeVisible();
  });
});
