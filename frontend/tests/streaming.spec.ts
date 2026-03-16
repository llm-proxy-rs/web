/**
 * UF-06  Empty thinking removed  — animated dots gone when no thinking_delta arrives
 * UF-07  Thinking block shown    — collapsible "Thinking…" when thinking content present
 * UF-08  Tool use with result    — tool card shows result after tool_result event
 * UF-09  Stop streaming          — Stop button sends stop request
 * UF-10  Ask user question       — panel shown; selecting an option and submitting works
 * UF-11  Stop sends task_id      — stop request body includes task_id from session_start
 * UF-12  Answer sends task_id    — answer request body includes task_id from ask_user_question
 * UF-59  multiSelect question    — "Select all that apply" shown; multiple selections joined with ", "
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("streaming", () => {
  test("UF-06 empty thinking indicator is removed when no thinking content arrives", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.noThinking("Reply without thinking", "sess-1"));

    await expect(page.getByText("Reply without thinking")).toBeVisible();

    // The animated ThinkingIndicator renders only when isThinking=true AND content=""
    // Our fix removes it on text_delta; assert it is NOT in the DOM.
    const thinkingIndicator = page.locator(".thinking-dot").first();
    await expect(thinkingIndicator).not.toBeVisible();
  });

  test("UF-07 thinking block shown as collapsible when thinking content is present", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Deep question");
    ctrl.sendSseEvents(sse.withThinking("My reasoning here…", "The answer is 42.", "sess-2"));

    // The collapsible <details> summary shows "Thinking…"
    await expect(page.getByText("Thinking…")).toBeVisible();
    // The assistant response is also shown
    await expect(page.getByText("The answer is 42.")).toBeVisible();
  });

  test("UF-08 tool card shown with result after tool_result event", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Run ls");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-1",
        "Bash",
        { command: "ls" },
        "file1.txt\nfile2.txt",
        "Done.",
        "sess-3",
      ),
    );

    // Tool name visible in the tool card
    await expect(page.getByText("Bash")).toBeVisible();
    // Click to expand the tool card and see the result
    await page.getByRole("button", { name: /Bash/ }).click();
    // Tool result visible inside the expanded card
    await expect(page.getByText("file1.txt")).toBeVisible();
    // Assistant follow-up text
    await expect(page.getByText("Done.")).toBeVisible();
  });

  test("UF-09 clicking Stop sends a stop request to the server", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    // Send a message so the streaming state activates (no SSE events yet)
    await sendMessage(page, "Long task");

    // The stop button is in the ClaudeStatus bar while streaming
    await expect(page.getByRole("status")).toBeVisible();
    await page.getByTitle("Stop (Esc)").first().click();

    expect(ctrl.stopRequested()).toBe(true);
  });

  test("UF-10 ask user question panel shown and answer submitted", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Help me choose");
    ctrl.sendSseEvents(
      sse.question("req-1", [
        {
          question: "Which option do you prefer?",
          header: "Preference",
          options: [
            { label: "Option A", description: "First choice" },
            { label: "Option B", description: "Second choice" },
          ],
        },
      ]),
    );

    // Panel header is visible
    await expect(page.getByText("Claude needs your input")).toBeVisible();
    await expect(page.getByText("Which option do you prefer?")).toBeVisible();

    // Click the first option
    await page.getByRole("button", { name: "Option A" }).click();

    // Submit the answer
    await page.getByRole("button", { name: "Submit" }).click();

    // The answer request should have been sent
    const answerBody = ctrl.lastAnswerBody();
    expect(answerBody?.request_id).toBe("req-1");
    expect(answerBody?.answers["Which option do you prefer?"]).toContain("Option A");
  });

  test("UF-11 stop request body includes the task_id from session_start", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Long task");

    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-abc" } },
      { event: "init" },
    ]);

    await expect(page.locator(".thinking-dot").first()).toBeVisible();

    const [stopReq] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("chat-stop") && r.method() === "POST"),
      page.getByTitle("Stop (Esc)").first().click(),
    ]);

    const stopBody = JSON.parse(stopReq.postData() ?? "{}") as { task_id?: string };
    expect(stopBody.task_id).toBe("task-abc");
  });

  test("UF-12 answer request body includes the task_id from ask_user_question", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Help me choose");
    ctrl.sendSseEvents(
      sse.question("req-2", [
        {
          question: "Pick one",
          header: "Choice",
          options: [
            { label: "Yes", description: "Affirmative" },
            { label: "No", description: "Negative" },
          ],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();
    await page.getByRole("button", { name: "Yes" }).click();

    const [answerReq] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("chat-question-answer") && r.method() === "POST"),
      page.getByRole("button", { name: "Submit" }).click(),
    ]);

    const answerBody = JSON.parse(answerReq.postData() ?? "{}") as {
      task_id?: string;
      request_id?: string;
    };
    expect(answerBody.task_id).toBe("client-sess-test");
    expect(answerBody.request_id).toBe("req-2");
  });

  test("UF-59 multiSelect question shows hint and joins multiple selections with comma", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Help me pick");
    ctrl.sendSseEvents(
      sse.question("req-59", [
        {
          question: "Which features do you want?",
          header: "Features",
          multiSelect: true,
          options: [
            { label: "Dark mode", description: "Switch to dark theme" },
            { label: "Notifications", description: "Enable alerts" },
            { label: "Analytics", description: "Usage tracking" },
          ],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();
    await expect(page.getByText("Which features do you want?")).toBeVisible();
    // multiSelect hint text
    await expect(page.getByText("Select all that apply")).toBeVisible();

    // Click two options — both should be selectable (multiSelect toggles, not replaces)
    await page.getByRole("button", { name: "Dark mode" }).click();
    await page.getByRole("button", { name: "Notifications" }).click();

    const [answerReq] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("chat-question-answer") && r.method() === "POST"),
      page.getByRole("button", { name: "Submit" }).click(),
    ]);

    const answerBody = JSON.parse(answerReq.postData() ?? "{}") as {
      answers: Record<string, string>;
    };
    // Both selected options are joined with ", " by buildAnswers()
    expect(answerBody.answers["Which features do you want?"]).toBe("Dark mode, Notifications");
  });
});
