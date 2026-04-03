/**
 * Task widget & tool renderers:
 * - TaskWidget auto-shows above composer when tasks exist
 * - TaskWidget hidden when no tasks
 * - TaskWidget collapsible via chevron
 * - TaskCreate renders as compact card in chat
 * - TaskUpdate renders with status badge
 * - TaskList renders as compact task list
 * - TodoWrite hidden from chat but populates task widget
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("task widget", () => {
  test("hidden when no tasks exist", async ({ page }) => {
    await setupApp(page, { sessions: [] });

    // No task widget should be visible
    await expect(page.locator("text=Tasks").first()).not.toBeVisible();
  });

  test("auto-shows when tasks are created via SSE", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Plan the work");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-tc",
        "TaskCreate",
        { subject: "Fix login bug" },
        JSON.stringify({
          task: { id: "1", subject: "Fix login bug", status: "pending" },
        }),
        "Created a task.",
        "sess-tc",
      ),
    );

    await expect(page.getByText("Created a task.")).toBeVisible();

    // TaskWidget should appear with the task
    await expect(page.getByText("Fix login bug").first()).toBeVisible();
  });

  test("shows status counts in header", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    // Create two tasks
    await sendMessage(page, "Create tasks");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-tc1",
        "TaskCreate",
        { subject: "Task A" },
        JSON.stringify({
          task: { id: "1", subject: "Task A", status: "pending" },
        }),
        "First.",
        "sess-tc1",
      ),
    );
    await expect(page.getByText("First.")).toBeVisible();

    // Update one to in_progress
    await sendMessage(page, "Start task");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-tu1",
        "TaskUpdate",
        { taskId: "1", status: "in_progress" },
        JSON.stringify({
          taskId: "1",
          statusChange: { from: "pending", to: "in_progress" },
        }),
        "Started.",
        "sess-tu1",
      ),
    );
    await expect(page.getByText("Started.")).toBeVisible();

    // Widget should show the task
    await expect(page.getByText("Task A").first()).toBeVisible();
  });

  test("collapsible via chevron click", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Create task");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-tc-col",
        "TaskCreate",
        { subject: "Collapsible task" },
        JSON.stringify({
          task: { id: "1", subject: "Collapsible task", status: "pending" },
        }),
        "Done.",
        "sess-col",
      ),
    );
    await expect(page.getByText("Done.")).toBeVisible();

    // Task should be visible (expanded by default)
    // "Collapsible task" appears in both chat card and widget — count should be 2
    await expect(page.getByText("Collapsible task")).toHaveCount(2);

    // Click the Tasks header to collapse
    await page.getByText("Tasks").first().click();

    // After collapsing, only the chat card instance remains
    await expect(page.getByText("Collapsible task")).toHaveCount(1);
  });
});

test.describe("task tool renderers", () => {
  test("TaskCreate renders as compact card in chat", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Create a task");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-tc-render",
        "TaskCreate",
        { subject: "Deploy service" },
        JSON.stringify({
          task: { id: "5", subject: "Deploy service", status: "pending" },
        }),
        "Done.",
        "sess-tc-render",
      ),
    );

    const card = page.getByTestId("assistant-card").last();
    await expect(card.getByText("#5")).toBeVisible();
    await expect(card.getByText("Deploy service")).toBeVisible();
    // Should NOT show raw JSON
    await expect(card.getByText('"status"')).not.toBeVisible();
  });

  test("TaskUpdate renders with status badge", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Update task");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-tu-render",
        "TaskUpdate",
        { taskId: "3", status: "completed" },
        JSON.stringify({
          taskId: "3",
          statusChange: { from: "in_progress", to: "completed" },
        }),
        "Done.",
        "sess-tu-render",
      ),
    );

    await expect(page.getByText("completed")).toBeVisible();
    await expect(page.getByText("#3").first()).toBeVisible();
  });

  test("TaskList renders as compact task list", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "List tasks");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-tl-render",
        "TaskList",
        {},
        JSON.stringify({
          tasks: [
            { id: "1", subject: "First task", status: "completed" },
            { id: "2", subject: "Second task", status: "in_progress" },
            {
              id: "3",
              subject: "Third task",
              status: "pending",
              blockedBy: ["2"],
            },
          ],
        }),
        "Listed.",
        "sess-tl-render",
      ),
    );

    await expect(page.getByText("Listed.")).toBeVisible();
    const card = page.getByTestId("assistant-card").last();
    await expect(card.getByText("First task")).toBeVisible();
    await expect(card.getByText("Second task")).toBeVisible();
    await expect(card.getByText("Third task")).toBeVisible();
    await expect(card.getByText("blocked by #2")).toBeVisible();
  });

  test("TodoWrite is hidden from chat but populates task widget", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Plan tasks");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-todo",
        "TodoWrite",
        {
          todos: [
            {
              content: "Fix auth bug",
              status: "in_progress",
              activeForm: "Fixing auth",
            },
            {
              content: "Write tests",
              status: "pending",
              activeForm: "Writing tests",
            },
          ],
        },
        "Todos have been modified successfully.",
        "Updated todos.",
        "sess-todo",
      ),
    );

    await expect(page.getByText("Updated todos.")).toBeVisible();

    // TodoWrite should NOT render a card in the chat stream
    const card = page.getByTestId("assistant-card").last();
    await expect(card.getByText("Todos (2)")).not.toBeVisible();

    // But task widget above composer should show the todos
    // in_progress task shows activeForm, not subject
    await expect(page.getByText("Fixing auth")).toBeVisible();
    await expect(page.getByText("Write tests")).toBeVisible();
  });
});
