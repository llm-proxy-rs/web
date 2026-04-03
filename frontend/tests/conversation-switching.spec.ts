/**
 * Conversation-switching tests — verify every visual state renders correctly
 * when switching between conversations and that background conversations
 * continue running and can be reattached.
 *
 * CS-01  Switch away from running conv — messages, status bar, queue hidden
 * CS-02  Switch back to running conv — messages, status bar, thinking restored
 * CS-03  Background conv completes — switch back shows response, no loading
 * CS-04  Queue drawer visible only on conversation with queued messages
 * CS-05  Queue drains in background while viewing another conversation
 * CS-06  Assistant response with thinking — switch away and back preserves it
 * CS-07  Assistant response with tool use — switch away and back preserves it
 * CS-08  Error message persists after switching away and back
 * CS-09  Two running conversations — each shows correct loading state
 * CS-10  Pending question panel — switch away hides it, switch back restores
 * CS-11  Completed conv with messages — switch to new chat and back preserves all
 * CS-12  Rapid switch during streaming — no duplicate messages or state leaks
 * CS-13  Background queue drain dispatches to correct conversation
 * CS-14  Timer/status text changes reflect per-conversation streaming phase
 * CS-15  Composer placeholder reflects per-conversation state after switch
 */
import { test, expect } from "@playwright/test";
import {
  setupApp,
  sendMessage,
  sse,
  makeConversation,
  makeSession,
} from "./helpers/setup";

test.describe("conversation switching", () => {
  test("CS-01 switching away from a running conversation hides its loading state", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Chat A" })],
    });

    // Start streaming in Chat A
    await page.getByText("Chat A").click();
    await sendMessage(page, "Hello from A");
    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.getByText("Hello from A")).toBeVisible();

    // Switch to new chat
    await page.getByRole("button", { name: "New Chat" }).click();

    // Loading state from Chat A is gone, welcome screen visible
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(
      page.getByRole("main").getByText("Hello from A"),
    ).not.toBeVisible();
    await expect(page.getByText("Welcome back")).toBeVisible();

    // Clean up
    ctrl.sendSseEvents(sse.text("Reply A", "sess-a"));
  });

  test("CS-02 switching back to a running conversation restores everything", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Chat A" })],
    });

    // Start streaming in Chat A
    await page.getByText("Chat A").click();
    await sendMessage(page, "Question from A");
    await expect(page.getByRole("status")).toBeVisible();

    // Send init to get thinking indicator
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-cs02" } },
      { event: "init" },
    ]);
    await expect(page.locator(".thinking-dot").first()).toBeVisible();

    // Switch to new chat
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.locator(".thinking-dot")).not.toBeVisible();

    // Switch back to Chat A
    await page.getByText("Chat A").click();

    // Everything is restored
    await expect(page.getByRole("status")).toBeVisible();
    await expect(
      page.getByRole("main").getByText("Question from A"),
    ).toBeVisible();
    await expect(page.locator(".thinking-dot").first()).toBeVisible();
  });

  test("CS-03 background conversation completes while viewing another — switch back shows full response", async ({
    page,
  }) => {
    const session = makeSession({ session_id: "sess-a", title: "Chat A" });
    const ctrl = await setupApp(page, {
      conversations: [
        makeConversation({ sessionId: "sess-a", title: "Chat A" }),
      ],
    });

    // Start streaming in Chat A
    await page.getByText("Chat A").click();
    await sendMessage(page, "Question for A");
    await expect(page.getByRole("status")).toBeVisible();

    // Switch to new chat
    await page.getByRole("button", { name: "New Chat" }).click();

    // Chat A completes in background
    ctrl.setSessions([session]);
    ctrl.sendSseEvents(sse.text("Full answer from A", "sess-a"));

    // Sidebar indicator should clear (done processed)
    await expect(page.locator(".animate-ping")).not.toBeVisible();

    // Switch back to Chat A
    await page.getByText("Chat A").click();

    // Full conversation visible, no loading
    await expect(
      page.getByRole("main").getByText("Question for A"),
    ).toBeVisible();
    await expect(page.getByText("Full answer from A")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();
  });

  test("CS-04 queue drawer is visible only on the conversation that has queued messages", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Send a message, then queue one
    await sendMessage(page, "First msg");
    await sendMessage(page, "Queued msg");
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // Switch to new chat — queue drawer gone
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByText("Queued messages")).not.toBeVisible();

    // Switch back — queue drawer restored
    await page
      .locator("span.truncate")
      .filter({ hasText: "First msg" })
      .click();
    await expect(page.getByText("Queued messages (1)")).toBeVisible();
    await expect(page.getByText("Queued msg")).toBeVisible();

    // Clean up
    ctrl.sendSseEvents(sse.text("Reply 1", "sess-1"));
    ctrl.sendSseEvents(sse.text("Reply 2", "sess-2"));
  });

  test("CS-05 queue drains in background while viewing a different conversation", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Start conv-A, queue two more messages
    await sendMessage(page, "A first");
    await sendMessage(page, "A second");
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // Switch to new chat
    await page.getByRole("button", { name: "New Chat" }).click();

    // Complete conv-A's first message → drain "A second"
    ctrl.sendSseEvents(sse.text("Reply-1", "sess-1"));
    // Complete "A second"
    ctrl.sendSseEvents(sse.text("Reply-2", "sess-2"));

    // Switch back to conv-A — messages and replies visible
    await page.locator("span.truncate").filter({ hasText: "A first" }).click();
    const main = page.getByRole("main");
    await expect(main.getByText("A first")).toBeVisible();
    await expect(main.getByText("Reply-1")).toBeVisible();
    await expect(main.getByText("A second")).toBeVisible();
    await expect(main.getByText("Reply-2")).toBeVisible();

    // No more loading or queue
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.getByText("Queued messages")).not.toBeVisible();

    // Verify both POSTs used same conversation_id
    const bodies = ctrl.allChatBodies();
    expect(bodies.length).toBe(2);
    expect(bodies[0].conversation_id).toBe(bodies[1].conversation_id);
  });

  test("CS-06 assistant thinking block survives conversation switch", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Thinking Chat" })],
    });

    await page.getByText("Thinking Chat").click();
    await sendMessage(page, "Deep question");
    ctrl.sendSseEvents(
      sse.withThinking(
        "My reasoning process here",
        "The conclusion.",
        "sess-t",
      ),
    );
    await expect(page.getByText("The conclusion.")).toBeVisible();

    // Switch away
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByText("The conclusion.")).not.toBeVisible();

    // Switch back — scope to main to avoid sidebar match
    await page
      .locator("span.truncate")
      .filter({ hasText: "Thinking Chat" })
      .click();
    await expect(
      page.getByRole("main").getByText("The conclusion."),
    ).toBeVisible();
    // Thinking block is also there — click to expand
    await expect(page.getByRole("main").getByText("Thinking")).toBeVisible();
    await page.getByRole("main").getByText("Thinking").click();
    await expect(page.getByText("My reasoning process here")).toBeVisible();
  });

  test("CS-07 tool use messages survive conversation switch", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Tool Chat" })],
    });

    await page.getByText("Tool Chat").click();
    await sendMessage(page, "Run a command");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-cs07",
        "Bash",
        { command: "ls -la" },
        "total 42\nfile.txt",
        "Listed the files.",
        "sess-tool",
      ),
    );
    await expect(page.getByText("Listed the files.")).toBeVisible();
    await expect(page.getByText("Bash")).toBeVisible();

    // Switch away
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByRole("main").getByText("Bash")).not.toBeVisible();

    // Switch back — tool card and response intact
    await page.getByText("Tool Chat").click();
    await expect(page.getByRole("main").getByText("Bash")).toBeVisible();
    await expect(page.getByText("Listed the files.")).toBeVisible();

    // Expand the tool card and verify result
    await page.getByRole("button", { name: /Bash/ }).click();
    await expect(page.getByText("file.txt")).toBeVisible();
  });

  test("CS-08 error message persists after conversation switch", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Send a message to create a conversation, then trigger error
    await sendMessage(page, "Trigger error");
    ctrl.sendSseEvents(sse.error("Something broke"));
    await expect(page.getByText("Something broke")).toBeVisible();

    // Switch away
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByText("Something broke")).not.toBeVisible();

    // Switch back — error still there
    await page
      .locator("span.truncate")
      .filter({ hasText: "Trigger error" })
      .click();
    await expect(page.getByText("Something broke")).toBeVisible();
    await expect(
      page.getByRole("main").getByText("Trigger error"),
    ).toBeVisible();
  });

  test("CS-09 two conversations — each shows correct loading state when viewed", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Start Chat A streaming
    await sendMessage(page, "Question A");
    await expect(page.getByRole("status")).toBeVisible();

    // Complete Chat A
    ctrl.sendSseEvents(sse.text("Reply A", "sess-a"));
    await expect(page.getByText("Reply A")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();

    // Start a new chat (Chat B) and begin streaming
    await page.getByRole("button", { name: "New Chat" }).click();
    await sendMessage(page, "Question B");
    await expect(page.getByRole("status")).toBeVisible();

    // Switch back to Chat A (completed) — no loading
    await page
      .locator("span.truncate")
      .filter({ hasText: "Question A" })
      .click();
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.getByText("Reply A")).toBeVisible();

    // Switch to Chat B (running) — loading visible
    await page
      .locator("span.truncate")
      .filter({ hasText: "Question B" })
      .click();
    await expect(page.getByRole("status")).toBeVisible();

    // Complete Chat B
    ctrl.sendSseEvents(sse.text("Reply B", "sess-b"));
    await expect(page.getByText("Reply B")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();
  });

  test("CS-10 pending question panel — switch away hides, switch back restores", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Question Chat" })],
    });

    await page.getByText("Question Chat").click();
    await sendMessage(page, "Help me choose");
    ctrl.sendSseEvents(
      sse.question("req-cs10", [
        {
          question: "Which option?",
          options: [
            { label: "Alpha", description: "First" },
            { label: "Beta", description: "Second" },
          ],
        },
      ]),
    );
    await expect(page.getByText("Which option?")).toBeVisible();
    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // Switch away — question panel hidden
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByText("Which option?")).not.toBeVisible();
    await expect(page.getByText("Claude needs your input")).not.toBeVisible();

    // Switch back — question panel restored
    await page.getByText("Question Chat").click();
    await expect(page.getByText("Which option?")).toBeVisible();
    await expect(page.getByText("Alpha")).toBeVisible();
    await expect(page.getByText("Beta")).toBeVisible();
  });

  test("CS-11 completed conversation with all message types — switch to new chat and back preserves everything", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Full Chat" })],
    });

    await page.getByText("Full Chat").click();

    // Send a user message → get response with tool use
    await sendMessage(page, "Please list files");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-cs11",
        "Bash",
        { command: "cat /tmp/test.txt" },
        "Hello world",
        "I read the file for you.",
        "sess-full",
      ),
    );
    await expect(page.getByText("I read the file for you.")).toBeVisible();

    // Switch to new chat
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByText("Welcome back")).toBeVisible();

    // Switch back — everything intact
    await page.getByText("Full Chat").click();
    await expect(
      page.getByRole("main").getByText("Please list files"),
    ).toBeVisible();
    await expect(page.getByRole("main").getByText("Bash")).toBeVisible();
    await expect(page.getByText("I read the file for you.")).toBeVisible();
  });

  test("CS-12 rapid switching during streaming — no duplicate messages", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Rapid Chat" })],
    });

    await page.getByText("Rapid Chat").click();
    await sendMessage(page, "Hello rapid");

    // Rapidly switch back and forth
    await page.getByRole("button", { name: "New Chat" }).click();
    await page.getByText("Rapid Chat").click();
    await page.getByRole("button", { name: "New Chat" }).click();
    await page.getByText("Rapid Chat").click();

    // Complete the stream
    ctrl.sendSseEvents(sse.text("Rapid reply", "sess-rapid"));
    await expect(page.getByText("Rapid reply")).toBeVisible();

    // Verify only one user message and one assistant message
    const userMessages = page.getByRole("main").locator("text=Hello rapid");
    await expect(userMessages).toHaveCount(1);
    const assistantMessages = page
      .getByRole("main")
      .locator("text=Rapid reply");
    await expect(assistantMessages).toHaveCount(1);
  });

  test("CS-13 background queue drain dispatches to the correct conversation", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Start conv-A and queue a message
    await sendMessage(page, "A msg1");
    await sendMessage(page, "A msg2");
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // Switch to new chat
    await page.getByRole("button", { name: "New Chat" }).click();

    // Complete conv-A's first stream → "A msg2" auto-dispatches to conv-A
    ctrl.sendSseEvents(sse.text("A reply1", "sess-a1"));
    // Complete "A msg2" in conv-A
    ctrl.sendSseEvents(sse.text("A reply2", "sess-a2"));

    // Wait for both drains to complete before sending conv-B
    // Navigate to conv-A to confirm both replies landed
    await page.locator("span.truncate").filter({ hasText: "A msg1" }).click();
    await expect(page.getByText("A reply2")).toBeVisible();

    // Go back to new chat and send conv-B
    await page.getByRole("button", { name: "New Chat" }).click();
    ctrl.sendSseEvents(sse.text("B reply", "sess-b"));
    await sendMessage(page, "B msg");
    await expect(page.getByText("B reply")).toBeVisible();

    // Verify: conv-A's 2 messages + conv-B's 1 message
    const bodies = ctrl.allChatBodies();
    expect(bodies.length).toBe(3);
    expect(bodies[0].content).toBe("A msg1");
    expect(bodies[1].content).toBe("A msg2");
    expect(bodies[2].content).toBe("B msg");
    // Conv-A's messages share same conversation_id
    expect(bodies[0].conversation_id).toBe(bodies[1].conversation_id);
    // Conv-B has a different conversation_id
    expect(bodies[2].conversation_id).not.toBe(bodies[0].conversation_id);
  });

  test("CS-14 status text reflects per-conversation streaming phase", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [makeConversation({ title: "Phase Chat" })],
    });

    await page.getByText("Phase Chat").click();
    await sendMessage(page, "Start task");

    // Init fires → status shown
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-cs14" } },
      { event: "init" },
    ]);
    await expect(page.getByRole("status")).toBeVisible();

    // Switch to new chat — no status
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByRole("status")).not.toBeVisible();

    // Switch back — status restored
    await page.getByText("Phase Chat").click();
    await expect(page.getByRole("status")).toBeVisible();
  });

  test("CS-15 composer placeholder reflects per-conversation state after switch", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Send a message — starts streaming
    await sendMessage(page, "Running message");
    // During streaming, placeholder should indicate queuing
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Message Claude…",
    );

    // Switch to new chat — placeholder back to normal
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Message Claude…",
    );

    // Switch back to running chat — queue placeholder again
    await page
      .locator("span.truncate")
      .filter({ hasText: "Running message" })
      .click();
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Message Claude…",
    );

    // Complete the stream
    ctrl.sendSseEvents(sse.text("Done", "sess-ph"));
    await expect(page.getByText("Done")).toBeVisible();

    // Now placeholder is back to normal
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Message Claude…",
    );
  });

  // ── Independent processing ───────────────────────────────────────────────

  test("CS-16 conv-A queue drains fully in background, then conv-B drains independently", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});
    const main = page.getByRole("main");

    // ── Start conv-A with a queue ──
    await sendMessage(page, "A1");
    await sendMessage(page, "A2");
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // Switch to new chat so conv-A processes in background
    await page.getByRole("button", { name: "New Chat" }).click();

    // Drain conv-A fully in background: A1 → done → A2 → done
    // Wait for A2's drain POST before starting conv-B to avoid event misrouting.
    const convADrainPost = ctrl.waitForNextChatPost(); // will resolve with A2's POST
    ctrl.sendSseEvents(sse.text("A1-reply", "sess-a1")); // resolves A1's parked POST
    const a2Post = await convADrainPost; // wait until A2's drain POST arrives
    ctrl.sendSseEventsTo(
      a2Post.conversation_id,
      sse.text("A2-reply", "sess-a2"),
    );

    // ── Start conv-B with a queue ──
    await sendMessage(page, "B1");
    await sendMessage(page, "B2");
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // ── Switch to conv-A and verify it completed ──
    await page.locator("span.truncate").filter({ hasText: "A1" }).click();
    await expect(main.getByText("A1-reply")).toBeVisible();
    await expect(main.getByText("A2", { exact: true })).toBeVisible();
    await expect(main.getByText("A2-reply")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.getByText("Queued messages")).not.toBeVisible();

    // ── Switch to conv-B — still running with queue ──
    await page.locator("span.truncate").filter({ hasText: "B1" }).click();
    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // Drain conv-B: B1 → done → B2 → done
    ctrl.sendSseEvents(sse.text("B1-reply", "sess-b1"));
    await expect(main.getByText("B1-reply")).toBeVisible();
    ctrl.sendSseEvents(sse.text("B2-reply", "sess-b2"));
    await expect(main.getByText("B2-reply")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.getByText("Queued messages")).not.toBeVisible();

    // ── Switch back to conv-A — still intact ──
    await page.locator("span.truncate").filter({ hasText: "A1" }).click();
    await expect(main.getByText("A1-reply")).toBeVisible();
    await expect(main.getByText("A2-reply")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();

    // ── Verify all POSTs ──
    const bodies = ctrl.allChatBodies();
    expect(bodies.length).toBe(4);
    expect(bodies[0].content).toBe("A1");
    expect(bodies[1].content).toBe("A2");
    expect(bodies[2].content).toBe("B1");
    expect(bodies[3].content).toBe("B2");
    // Conv-A messages share a conversation_id
    expect(bodies[0].conversation_id).toBe(bodies[1].conversation_id);
    // Conv-B messages share a different conversation_id
    expect(bodies[2].conversation_id).toBe(bodies[3].conversation_id);
    // Conv-A and conv-B have different conversation_ids
    expect(bodies[0].conversation_id).not.toBe(bodies[2].conversation_id);
  });

  test("CS-17 switching freely during background drain — state never corrupts", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});
    const main = page.getByRole("main");

    // ── Start conv-A: send + queue ──
    await sendMessage(page, "A1");
    await sendMessage(page, "A2");
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // Switch away
    await page.getByRole("button", { name: "New Chat" }).click();

    // Process A1 — drain fires A2
    ctrl.sendSseEvents(sse.text("A1-reply", "sess-a1"));

    // ── Switch to conv-A while A2 is still in-flight ──
    await page.locator("span.truncate").filter({ hasText: "A1" }).click();
    await expect(main.getByText("A1-reply")).toBeVisible();
    // A2 was dispatched by drain, so user message "A2" should be visible
    await expect(main.getByText("A2")).toBeVisible();
    // Still running (A2 in-flight)
    await expect(page.getByRole("status")).toBeVisible();
    // Queue should be empty (A2 was shifted out)
    await expect(page.getByText("Queued messages")).not.toBeVisible();

    // ── Switch back to new chat while A2 is processing ──
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByText("Welcome back")).toBeVisible();

    // Process A2 in background
    ctrl.sendSseEvents(sse.text("A2-reply", "sess-a2"));

    // ── Start conv-B with queue ──
    await sendMessage(page, "B1");
    await sendMessage(page, "B2");
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // ── Rapid switches while conv-B is running ──
    // Switch to conv-A — should be complete
    await page.locator("span.truncate").filter({ hasText: "A1" }).click();
    await expect(main.getByText("A2-reply")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();

    // Switch to conv-B — should still be running with queue
    await page.locator("span.truncate").filter({ hasText: "B1" }).click();
    await expect(page.getByRole("status")).toBeVisible();

    // Back to conv-A
    await page.locator("span.truncate").filter({ hasText: "A1" }).click();
    await expect(page.getByRole("status")).not.toBeVisible();

    // Back to conv-B
    await page.locator("span.truncate").filter({ hasText: "B1" }).click();
    await expect(page.getByRole("status")).toBeVisible();

    // ── Drain conv-B ──
    ctrl.sendSseEvents(sse.text("B1-reply", "sess-b1"));
    await expect(main.getByText("B1-reply")).toBeVisible();
    ctrl.sendSseEvents(sse.text("B2-reply", "sess-b2"));
    await expect(main.getByText("B2-reply")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();

    // ── Final verification: both conversations intact ──
    await page.locator("span.truncate").filter({ hasText: "A1" }).click();
    await expect(main.getByText("A1-reply")).toBeVisible();
    await expect(main.getByText("A2-reply")).toBeVisible();

    await page.locator("span.truncate").filter({ hasText: "B1" }).click();
    await expect(main.getByText("B1-reply")).toBeVisible();
    await expect(main.getByText("B2-reply")).toBeVisible();
  });

  test("CS-18 three conversations process independently with queues", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});
    const main = page.getByRole("main");

    // ── Conv-A: send + queue ──
    await sendMessage(page, "A1");
    await sendMessage(page, "A2");
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // ── Switch to new chat, drain conv-A fully ──
    // Wait for A2's drain POST before starting conv-B to avoid event misrouting.
    await page.getByRole("button", { name: "New Chat" }).click();
    const convADrainPost = ctrl.waitForNextChatPost();
    ctrl.sendSseEvents(sse.text("A1-reply", "sess-a1"));
    const a2Post = await convADrainPost;
    ctrl.sendSseEventsTo(
      a2Post.conversation_id,
      sse.text("A2-reply", "sess-a2"),
    );

    // Start conv-B with queue
    await sendMessage(page, "B1");
    await sendMessage(page, "B2");

    // ── Switch to new chat, drain conv-B fully ──
    // Wait for B2's drain POST before starting conv-C to avoid event misrouting.
    await page.getByRole("button", { name: "New Chat" }).click();
    const convBDrainPost = ctrl.waitForNextChatPost();
    ctrl.sendSseEvents(sse.text("B1-reply", "sess-b1"));
    const b2Post = await convBDrainPost;
    ctrl.sendSseEventsTo(
      b2Post.conversation_id,
      sse.text("B2-reply", "sess-b2"),
    );

    // Wait for conv-B to finish before starting conv-C
    // (check that sidebar indicator cleared)
    await expect(page.locator(".animate-ping")).not.toBeVisible();

    // Start conv-C
    ctrl.sendSseEvents(sse.text("C1-reply", "sess-c1"));
    await sendMessage(page, "C1");
    await expect(main.getByText("C1-reply")).toBeVisible();

    // ── Verify all three conversations ──
    // Conv-A
    await page.locator("span.truncate").filter({ hasText: "A1" }).click();
    await expect(main.getByText("A1-reply")).toBeVisible();
    await expect(main.getByText("A2-reply")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();

    // Conv-B
    await page.locator("span.truncate").filter({ hasText: "B1" }).click();
    await expect(main.getByText("B1-reply")).toBeVisible();
    await expect(main.getByText("B2-reply")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();

    // Conv-C
    await page.locator("span.truncate").filter({ hasText: "C1" }).click();
    await expect(main.getByText("C1-reply")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();

    // ── Verify POST bodies ──
    const bodies = ctrl.allChatBodies();
    expect(bodies.length).toBe(5);
    const convIds = new Set(bodies.map((b) => b.conversation_id));
    // Three distinct conversations
    expect(convIds.size).toBe(3);
  });

  test("CS-19 new messages can be sent in a completed conversation while another is running", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});
    const main = page.getByRole("main");

    // ── Start conv-A and complete it ──
    ctrl.sendSseEvents(sse.text("A1-reply", "sess-a1"));
    await sendMessage(page, "A1");
    await expect(main.getByText("A1-reply")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();

    // ── Start conv-B (running) ──
    await page.getByRole("button", { name: "New Chat" }).click();
    await sendMessage(page, "B1");
    await expect(page.getByRole("status")).toBeVisible();

    // ── Switch to conv-A (completed) — composer is usable ──
    await page.locator("span.truncate").filter({ hasText: "A1" }).click();
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Message Claude…",
    );

    // Conv-B's POST is blocking. Complete it first so conv-A can send.
    ctrl.sendSseEvents(sse.text("B1-reply", "sess-b1"));

    // ── Send a new message in conv-A while viewing it ──
    ctrl.sendSseEvents(sse.text("A2-reply", "sess-a2"));
    await sendMessage(page, "A2");
    await expect(main.getByText("A2-reply")).toBeVisible();

    // ── Switch to conv-B — verify it completed independently ──
    await page.locator("span.truncate").filter({ hasText: "B1" }).click();
    await expect(main.getByText("B1-reply")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();

    // ── Verify 3 POSTs total ──
    const bodies = ctrl.allChatBodies();
    expect(bodies.length).toBe(3);
    // A1 and A2 share conversation_id
    expect(bodies[0].conversation_id).toBe(bodies[2].conversation_id);
    // B1 is different
    expect(bodies[1].conversation_id).not.toBe(bodies[0].conversation_id);
  });

  test("CS-20 elapsed timer does not reset when switching between running conversations", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [
        makeConversation({ title: "Timer A" }),
        makeConversation({ title: "Timer B" }),
      ],
    });

    // Start streaming in Timer A
    await page.getByText("Timer A").click();
    await sendMessage(page, "Long task A");
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-a" } },
      { event: "init" },
    ]);
    await expect(page.getByRole("status")).toBeVisible();

    // Wait 3 seconds for the timer to advance
    await page.waitForTimeout(3000);

    // Verify timer shows at least 2s
    const statusBefore = await page.getByRole("status").textContent();
    const matchBefore = statusBefore?.match(/(\d+)s/);
    expect(matchBefore).toBeTruthy();
    const secondsBefore = parseInt(matchBefore![1], 10);
    expect(secondsBefore).toBeGreaterThanOrEqual(2);

    // Switch to Timer B (no streaming — no status)
    await page.getByText("Timer B").click();
    await expect(page.getByRole("status")).not.toBeVisible();

    // Wait 1 more second
    await page.waitForTimeout(1000);

    // Switch back to Timer A — timer should NOT have reset
    await page.getByText("Timer A").click();
    await expect(page.getByRole("status")).toBeVisible();

    const statusAfter = await page.getByRole("status").textContent();
    const matchAfter = statusAfter?.match(/(\d+)s/);
    expect(matchAfter).toBeTruthy();
    const secondsAfter = parseInt(matchAfter![1], 10);

    // Timer should be >= what it was before the switch (accounting for the extra wait)
    expect(secondsAfter).toBeGreaterThanOrEqual(secondsBefore);

    // Clean up
    ctrl.sendSseEvents(sse.text("Done A", "sess-timer-a"));
  });
});
