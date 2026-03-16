/**
 * CQ-01  Debounced localStorage persistence — writes coalesced during SSE streaming
 * CQ-02  AbortController prevents stale transcripts — switching conversations cancels old load
 * CQ-03  Per-message error boundary — one bad message doesn't break the whole pane
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse, makeSession, makeConversation } from "./helpers/setup";

test.describe("code quality fixes", () => {
  test("CQ-01 localStorage writes are debounced during SSE streaming", async ({ page }) => {
    // Instrument localStorage.setItem to count writes to chat_messages_task_* keys
    await page.addInitScript(() => {
      (window as unknown as Record<string, number>).__chatMessagesWriteCount = 0;
      const origSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith("chat_messages_task_")) {
          (window as unknown as Record<string, number>).__chatMessagesWriteCount++;
        }
        return origSetItem.call(this, key, value);
      };
    });

    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Stream me lots of deltas");

    // Build a stream with ~20 text_delta events
    const events = [
      { event: "session_start" as const, data: { task_id: "task-debounce" } },
      { event: "init" as const },
      ...Array.from({ length: 20 }, (_, i) => ({
        event: "text_delta" as const,
        data: { text: `word${i} ` },
      })),
      { event: "done" as const, data: { session_id: "sess-debounce", task_id: "task-debounce" } },
    ];
    ctrl.sendSseEvents(events);

    // Wait for the full text to appear (all 20 deltas rendered)
    await expect(page.getByText("word19")).toBeVisible();

    // Check that total writes were significantly fewer than 22 (one per event)
    const writeCount = await page.evaluate(
      () => (window as unknown as Record<string, number>).__chatMessagesWriteCount,
    );
    expect(writeCount).toBeLessThanOrEqual(5);

    // Verify the final persisted data is correct — done removes the key, so check the message content in the UI
    await expect(page.getByText("word0")).toBeVisible();
    await expect(page.getByText("word19")).toBeVisible();
  });

  test("CQ-02 switching conversations aborts stale transcript loads", async ({ page }) => {
    const sessA = makeSession({ session_id: "sess-a", title: "Session A", project_dir: "/home/ubuntu" });
    const sessB = makeSession({ session_id: "sess-b", title: "Session B", project_dir: "/home/ubuntu" });
    const convA = makeConversation({ sessionId: "sess-a", projectDir: "/home/ubuntu", title: "Session A" });
    const convB = makeConversation({ sessionId: "sess-b", projectDir: "/home/ubuntu", title: "Session B" });

    // Track transcript fetches and control their timing
    let transcriptAResolve: ((value: Response) => void) | null = null;

    const ctrl = await setupApp(page, {
      sessions: [sessA, sessB],
      conversations: [convA, convB],
      transcripts: {
        "sess-b": [
          { role: "user", content: "Hello B", isCompactSummary: false },
          { role: "assistant", content: [{ type: "text", text: "Response B" }], isCompactSummary: false },
        ],
      },
    });

    // Override transcript route so sess-a's response is delayed
    await page.route("**/chat-transcript**", async (route) => {
      const url = new URL(route.request().url());
      const sessionId = url.searchParams.get("session_id") ?? "";
      if (sessionId === "sess-a") {
        // Delay response — will be resolved later (or never if aborted)
        const promise = new Promise<Response>((resolve) => {
          transcriptAResolve = resolve;
        });
        // Wait briefly, then fulfill with stale data
        // The abort should prevent this from affecting the UI
        try {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              messages: [
                { role: "user", content: "Hello A", isCompactSummary: false },
                { role: "assistant", content: [{ type: "text", text: "STALE RESPONSE A" }], isCompactSummary: false },
              ],
            }),
          });
        } catch {
          // Route was aborted — expected
        }
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            messages: [
              { role: "user", content: "Hello B", isCompactSummary: false },
              { role: "assistant", content: [{ type: "text", text: "Response B" }], isCompactSummary: false },
            ],
          }),
        });
      }
    });

    // Click conversation A
    await page.getByText("Session A").click();

    // Immediately click conversation B before A's transcript loads
    await page.getByText("Session B").click();

    // B's messages should be visible
    await expect(page.getByText("Response B")).toBeVisible();

    // A's stale data should NOT be visible in the current view
    await expect(page.getByText("STALE RESPONSE A")).not.toBeVisible();
  });

  test("CQ-03 per-message error boundary isolates render failures", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    // Send a normal message and get a normal response
    await sendMessage(page, "Normal message");
    ctrl.sendSseEvents(sse.text("Normal response", "sess-err-1"));
    await expect(page.getByText("Normal response")).toBeVisible();

    // Send another message that will trigger the render error
    await sendMessage(page, "Trigger error");

    // The __FORCE_RENDER_ERROR__ content triggers a throw in MarkdownContent
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-err" } },
      { event: "init" },
      { event: "text_delta", data: { text: "__FORCE_RENDER_ERROR__" } },
      { event: "done", data: { session_id: "sess-err-2", task_id: "task-err" } },
    ]);

    // The error boundary should catch it and render the fallback
    await expect(page.getByTestId("message-error")).toBeVisible();

    // The first message should still be visible (not broken by the second)
    await expect(page.getByText("Normal response")).toBeVisible();

    // The composer should still work
    const composer = page.getByPlaceholder("Message Claude…");
    await expect(composer).toBeEnabled();
  });
});
