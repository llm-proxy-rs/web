/**
 * Staleness watchdog & question-answer recovery
 *
 * UF-95  Pending question prevents staleness — conversation stays running while question panel is visible
 * UF-96  Question panel survives answer POST failure — panel stays visible so user can retry
 * UF-97  Skip survives POST failure — panel stays visible on error
 * UF-98  Queue drains correctly after question is answered
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("staleness & question recovery", () => {
  test("UF-95 pending question prevents staleness — conversation stays running", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Send a message to start streaming
    await sendMessage(page, "Hello");

    // Server responds with a question (e.g., EnterPlanMode approval)
    ctrl.sendSseEvents(
      sse.question("req-plan-1", [
        {
          question: "Enter plan mode?",
          options: [
            { label: "Yes", description: "Enter plan mode" },
            { label: "No", description: "Stay in normal mode" },
          ],
        },
      ]),
    );

    // Question panel should be visible
    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // The status indicator should still show (conversation is running)
    // Even though no SSE events are flowing, the conversation should NOT
    // be marked stale because a question is pending.
    // We can't easily wait 90s in a test, but we verify the conversation
    // is still considered running by checking the stop button is present.
    await expect(page.getByText("Enter plan mode?")).toBeVisible();

    // Answer the question — select option first, then submit
    await page.getByRole("button", { name: "Yes" }).click();

    const [answerReq] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("chat-question-answer") && r.method() === "POST",
      ),
      page.getByRole("button", { name: "Submit" }).click(),
    ]);

    const body = JSON.parse(answerReq.postData() ?? "{}") as {
      answers: Record<string, string>;
    };
    expect(body.answers["Enter plan mode?"]).toBe("Yes");

    // Question panel should be gone after successful answer
    await expect(page.getByText("Claude needs your input")).not.toBeVisible();
  });

  test("UF-96 question panel stays visible when answer POST fails", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { answerError: "Internal Server Error" });

    await sendMessage(page, "Hello");

    ctrl.sendSseEvents(
      sse.question("req-fail-1", [
        {
          question: "Choose an option",
          options: [
            { label: "Option A", description: "First choice" },
            { label: "Option B", description: "Second choice" },
          ],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // Select an option and try to submit
    await page.getByRole("button", { name: "Option A" }).click();
    await page.getByRole("button", { name: "Submit" }).click();

    // Wait for the failed POST to complete
    await page.waitForResponse(
      (r) => r.url().includes("chat-question-answer") && r.status() === 500,
    );

    // Question panel should STILL be visible because the POST failed
    await expect(page.getByText("Claude needs your input")).toBeVisible();
    await expect(page.getByText("Choose an option")).toBeVisible();
  });

  test("UF-97 skip keeps question panel visible when POST fails", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { answerError: "Internal Server Error" });

    await sendMessage(page, "Hello");

    ctrl.sendSseEvents(
      sse.question("req-skip-fail-1", [
        {
          question: "Should we continue?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // Click Skip
    await page.getByText("Skip").click();

    // Wait for the failed POST
    await page.waitForResponse(
      (r) => r.url().includes("chat-question-answer") && r.status() === 500,
    );

    // Question panel should still be visible
    await expect(page.getByText("Claude needs your input")).toBeVisible();
    await expect(page.getByText("Should we continue?")).toBeVisible();
  });

  test("UF-98 queue drains correctly after question is answered", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Send first message
    await sendMessage(page, "First");

    // Queue a second message while the first is streaming
    await sendMessage(page, "Second");
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // Server sends a question then completes the first stream in the same SSE response.
    // The mock delivers all events in one HTTP response body, so done must be included here.
    ctrl.sendSseEvents([
      ...sse.question("req-q-1", [
        {
          question: "Approve this action?",
          options: [{ label: "Allow" }, { label: "Deny" }],
        },
      ]),
      {
        event: "done",
        data: { session_id: "sess-1", task_id: "client-sess-test" },
      },
    ]);

    // Question panel appears (hides queue drawer)
    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // Answer the question
    await page.getByRole("button", { name: "Allow" }).click();

    // Wait for the answer POST to succeed, then the drain logic dispatches the queued "Second" message
    await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("chat-question-answer") && r.method() === "POST",
      ),
      page.getByRole("button", { name: "Submit" }).click(),
    ]);

    // Question panel should be gone after successful answer
    await expect(page.getByText("Claude needs your input")).not.toBeVisible();

    // The queued "Second" message should auto-dispatch; provide its SSE response
    ctrl.sendSseEvents(sse.text("Response to second", "sess-2"));
    await expect(page.getByText("Response to second")).toBeVisible();

    // Verify both POSTs fired
    const bodies = ctrl.allChatBodies();
    expect(bodies.length).toBe(2);
    expect(bodies[0].content).toBe("First");
    expect(bodies[1].content).toBe("Second");
  });

  test("UF-99 stale drain retries once then stops on consecutive stale", async ({
    page,
  }) => {
    await page.clock.install();
    const ctrl = await setupApp(page, {});

    // Send first message (POST hangs — no SSE events delivered)
    await sendMessage(page, "First");
    // Queue two more messages while streaming
    await sendMessage(page, "Second");
    await sendMessage(page, "Third");
    await expect(page.getByText("Queued messages (2)")).toBeVisible();

    expect(ctrl.allChatBodies().length).toBe(1);

    // Fast-forward past stale threshold (90s) + one check interval (15s)
    await page.clock.fastForward(105_000);

    // First stale → drain retries: "Second" should be dispatched
    await expect.poll(() => ctrl.allChatBodies().length).toBe(2);
    expect(ctrl.allChatBodies()[1].content).toBe("Second");

    // Wait for React to fully settle (addRunningConversation state update +
    // stale watchdog useEffect re-setup) before advancing time again.
    await page.waitForFunction(() => true);

    // Fast-forward again → second consecutive stale
    await page.clock.fastForward(105_000);

    // Drain should be SKIPPED — no third POST even after extra time
    await page.clock.fastForward(30_000);
    expect(ctrl.allChatBodies().length).toBe(2);

    // "Third" should still be in the queue (not lost)
    await expect(page.getByText("Queued messages (1)")).toBeVisible();
  });

  test("UF-100 user send resets stale counter so queue resumes", async ({
    page,
  }) => {
    await page.clock.install();
    const ctrl = await setupApp(page, {});

    // Send first message (hangs) and queue a second
    await sendMessage(page, "First");
    await sendMessage(page, "Second");
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // Two consecutive stales → drain stops
    // First stale: drain retries "Second" (POST #2)
    await page.clock.fastForward(105_000);
    await expect.poll(() => ctrl.allChatBodies().length).toBe(2);
    // Second stale: drain skipped
    await page.clock.fastForward(105_000);

    // User manually sends a new message — this resets the stale counter.
    // The conversation is idle (removed from running by stale watchdog), so
    // handleSend dispatches directly (POST #3).
    await sendMessage(page, "Manual retry");
    await expect.poll(() => ctrl.allChatBodies().length).toBe(3);

    // The mock has 3 pending waiters (POST #1, #2 aborted but mock doesn't
    // know; POST #3 is the real one).  Flush the two stale waiters first.
    ctrl.sendSseEvents(sse.text("ignored1", "sess-stale1"));
    ctrl.sendSseEvents(sse.text("ignored2", "sess-stale2"));
    // Now deliver the real response for the manual retry
    ctrl.sendSseEvents(sse.text("Got it", "sess-retry"));
    await expect(page.getByText("Got it")).toBeVisible();

    // Verify the manual send went through
    const bodies = ctrl.allChatBodies();
    expect(bodies[bodies.length - 1].content).toBe("Manual retry");
  });
});
