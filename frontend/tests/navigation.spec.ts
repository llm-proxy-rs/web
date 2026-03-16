/**
 * UF-34  New Chat mid-stream (null session)    — status bar hides immediately after clicking New Chat
 * UF-35  Done fires after stale New Chat       — status bar stays hidden, view stays blank
 * UF-35b Error fires after stale New Chat      — no error shown, view stays blank
 * UF-36  New session in sidebar after stale done — session appears but view stays blank
 * UF-37  New Chat while streaming existing session — status bar disappears immediately
 * UF-38  Sidebar pulsing indicator stays        — shown on running session after navigating away
 * UF-39  Navigate back to running session       — status bar reappears
 * UF-40  Done fires while viewing new chat      — sidebar indicator clears, view unchanged
 * UF-41  Non-running session disables composer  — blocked while another session is streaming
 * UF-42  Click existing session mid-stream (null) — status bar disappears
 * UF-43  New Chat hides thinking indicator      — animated dots disappear when navigating away
 * UF-44  Navigate back shows thinking indicator — animated dots reappear when returning to running session
 * UF-45  SSE events routed to running session   — text arrives in sess-a, not in viewed sess-b
 * UF-46  Composer re-enables after done         — input active again once running session completes
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse, makeSession, makeConversation } from "./helpers/setup";

test.describe("navigation during streaming", () => {
  // ── Null-session streaming ─────────────────────────────────────────────────

  test("UF-34 clicking New Chat while a null-session stream is pending hides the status bar", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    await expect(page.getByRole("status")).toBeVisible();

    // Click New Chat — orphans the running conversation, status bar hides immediately
    await page.getByRole("button", { name: "New Chat" }).click();

    await expect(page.getByRole("status")).not.toBeVisible();

    // Clean up so the stream doesn't leak into the next test
    ctrl.sendSseEvents([{ event: "done", data: { session_id: null, task_id: "t" } }]);
    await expect(page.getByRole("status")).not.toBeVisible();
  });

  test("UF-35 status bar stays hidden when done fires after a stale New Chat click", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByRole("status")).not.toBeVisible();

    ctrl.sendSseEvents(sse.text("The response", "sess-new"));

    // done fires → stays hidden, view stays blank (no navigation to the new conversation)
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.getByText("Start a new conversation")).toBeVisible();
  });

  test("UF-35b error fires after a stale New Chat click — no error shown in blank view", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByRole("status")).not.toBeVisible();

    ctrl.sendSseEvents([{ event: "error_event", data: { message: "something went wrong" } }]);

    // error_event fires for an orphaned stream — error is silently discarded from blank view
    await expect(page.getByText("something went wrong")).not.toBeVisible();
    await expect(page.getByText("Start a new conversation")).toBeVisible();
  });

  test("UF-36 new session appears in the sidebar even when New Chat was clicked mid-stream", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    await page.getByRole("button", { name: "New Chat" }).click();

    // Pre-populate history so the refresh triggered by done returns the new session
    ctrl.setSessions([makeSession({ session_id: "sess-new", title: "My stale session" })]);
    ctrl.sendSseEvents(sse.text("The response", "sess-new"));

    // New session surfaces in the sidebar from the history refresh
    await expect(
      page.locator("span.truncate").filter({ hasText: "My stale session" }),
    ).toBeVisible();
    // But the current view is still blank — no navigation to the stale conversation
    await expect(page.getByText("Start a new conversation")).toBeVisible();
  });

  // ── Existing-session streaming ────────────────────────────────────────────

  test("UF-37 clicking New Chat while streaming an existing session immediately hides the status bar", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Old Chat" })],
    });

    await page.getByText("Old Chat").click();
    await sendMessage(page, "Hello from Old Chat");
    await expect(page.getByRole("status")).toBeVisible();

    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByRole("status")).not.toBeVisible();
  });

  test("UF-38 sidebar pulsing indicator stays on the running session after navigating to new chat", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Running Session" })],
    });

    await page.getByText("Running Session").click();
    await sendMessage(page, "Long task");
    await page.getByRole("button", { name: "New Chat" }).click();

    // Status bar is gone (different session context) but the sidebar dot still pulses
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.locator(".animate-ping")).toBeVisible();
  });

  test("UF-39 navigating back to the running session restores the status bar", async ({ page }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Running Session" })],
    });

    await page.getByText("Running Session").click();
    await sendMessage(page, "Long task");
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByRole("status")).not.toBeVisible();

    // Click the conversation row to return
    await page.getByText("Running Session").click();
    await expect(page.getByRole("status")).toBeVisible();
  });

  test("UF-40 done fires while viewing new chat — sidebar indicator clears, view unchanged", async ({
    page,
  }) => {
    const session = makeSession({ session_id: "sess-a", title: "Running Session" });
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ sessionId: "sess-a", title: "Running Session" })],
    });

    await page.getByText("Running Session").click();
    await sendMessage(page, "Long task");
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.locator(".animate-ping")).toBeVisible();

    // Complete the stream while the user is on the new-chat view
    ctrl.setSessions([session]);
    ctrl.sendSseEvents(sse.text("Finished.", "sess-a"));

    // Sidebar pulsing indicator clears (runningConversationId set to null)
    await expect(page.locator(".animate-ping")).not.toBeVisible();
    // Status bar stays hidden (we are not viewing Running Session)
    await expect(page.getByRole("status")).not.toBeVisible();
    // The new-chat blank state is unchanged
    await expect(page.getByText("Start a new conversation")).toBeVisible();
  });

  // ── Cross-session navigation ───────────────────────────────────────────────

  test("UF-41 viewing a non-running session disables the composer while another session is streaming", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Other Chat" })],
    });

    // Start streaming from the new-chat blank view
    await sendMessage(page, "Streaming from new chat");
    await expect(page.getByRole("status")).toBeVisible();

    // Switch to an existing conversation — it is not the running one
    await page.getByText("Other Chat").click();

    // isCurrentRunning=false for this conversation → no status bar
    // isOtherRunning=true → composer is disabled to prevent cross-session routing
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.getByPlaceholder("Message Claude…")).toBeDisabled();
  });

  test("UF-42 clicking an existing session while a pending-session stream is running hides the status bar", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Previous Chat" })],
    });

    await sendMessage(page, "Hello");
    await expect(page.getByRole("status")).toBeVisible();

    // Navigate to the existing conversation
    await page.getByText("Previous Chat").click();
    await expect(page.getByRole("status")).not.toBeVisible();

    // Running conversation still pulses (runningConversationId matches its placeholder row)
    await expect(page.locator(".animate-ping")).toBeVisible();
  });

  // ── Thinking indicator visibility ─────────────────────────────────────────

  test("UF-43 clicking New Chat while the thinking indicator is visible hides it", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Running Session" })],
    });

    await page.getByText("Running Session").click();
    await sendMessage(page, "Long task");
    await expect(page.getByRole("status")).toBeVisible();

    // init fires → thinking indicator added to the running conversation's messages
    ctrl.sendSseEvents([{ event: "init" }]);
    await expect(page.locator(".thinking-dot").first()).toBeVisible();

    // Navigate to New Chat — running conversation's messages are no longer shown
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.locator(".thinking-dot").first()).not.toBeVisible();
  });

  test("UF-44 navigating back to the running session restores the thinking indicator", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Running Session" })],
    });

    await page.getByText("Running Session").click();
    await sendMessage(page, "Long task");
    await expect(page.getByRole("status")).toBeVisible();

    // init fires → thinking indicator added
    ctrl.sendSseEvents([{ event: "init" }]);
    await expect(page.locator(".thinking-dot").first()).toBeVisible();

    // Navigate away — thinking indicator hidden
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.locator(".thinking-dot").first()).not.toBeVisible();

    // Return to the running session — thinking indicator reappears
    await page.getByText("Running Session").click();
    await expect(page.locator(".thinking-dot").first()).toBeVisible();
  });

  // ── Cross-session isolation ────────────────────────────────────────────────

  test("UF-45 SSE events during cross-session viewing route to the running session not the viewed one", async ({
    page,
  }) => {
    const sessA = makeSession({ session_id: "sess-a", title: "Session A" });
    const sessB = makeSession({ session_id: "sess-b", title: "Session B" });
    const ctrl = await setupApp(page, {
      conversations: [
        makeConversation({ sessionId: "sess-a", title: "Session A" }),
        makeConversation({ sessionId: "sess-b", title: "Session B" }),
      ],
    });

    // Start streaming from Session A
    await page.getByText("Session A").click();
    await sendMessage(page, "Question for A");
    await expect(page.getByRole("status")).toBeVisible();

    // Navigate to Session B while Session A is still streaming
    await page.getByText("Session B").click();

    // SSE events arrive (for Session A's request)
    ctrl.setSessions([sessA, sessB]);
    ctrl.sendSseEvents(sse.text("Answer for A", "sess-a"));

    // Session B shows none of Session A's response
    await expect(page.getByText("Answer for A")).not.toBeVisible();

    // Navigate back to Session A — the response is there
    await page.getByText("Session A").click();
    await expect(page.getByText("Answer for A")).toBeVisible();
  });

  test("UF-46 composer re-enables after the running session completes while viewing a different session", async ({
    page,
  }) => {
    const sessA = makeSession({ session_id: "sess-a", title: "Session A" });
    const sessB = makeSession({ session_id: "sess-b", title: "Session B" });
    const ctrl = await setupApp(page, {
      conversations: [
        makeConversation({ sessionId: "sess-a", title: "Session A" }),
        makeConversation({ sessionId: "sess-b", title: "Session B" }),
      ],
    });

    // Start streaming from Session A
    await page.getByText("Session A").click();
    await sendMessage(page, "Question for A");

    // Navigate to Session B — composer is disabled while Session A is running
    await page.getByText("Session B").click();
    await expect(page.getByPlaceholder("Message Claude…")).toBeDisabled();

    // Session A's stream completes
    ctrl.setSessions([sessA, sessB]);
    ctrl.sendSseEvents(sse.text("Answer for A", "sess-a"));

    // Composer in Session B re-enables now that no session is running
    await expect(page.getByPlaceholder("Message Claude…")).toBeEnabled();
  });
});
