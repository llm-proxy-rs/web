/**
 * MP-01  Messages persist after stream completes and page reloads
 * MP-02  Messages restored from localStorage when conversation has no sessionId
 * MP-03  Server transcript takes priority over localStorage when sessionId exists
 * MP-04  Deleting a conversation cleans up its localStorage messages
 */
import { test, expect } from "@playwright/test";
import {
  setupApp,
  makeConversation,
  makeSession,
  sendMessage,
  sse,
  VM_ID,
} from "./helpers/setup";

test.describe("message-persistence", () => {
  test("MP-01 messages persist to localStorage after stream completes", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      sessions: [makeSession({ session_id: "sess-p1" })],
    });

    // Send a message — the mock will wait for SSE events
    ctrl.sendSseEvents(sse.text("Hello from Claude!", "sess-p1"));
    await sendMessage(page, "Hi there");

    // Wait for response to render
    await expect(page.getByText("Hello from Claude!")).toBeVisible();

    // Grab the conversation_id the frontend assigned
    const convId = ctrl.lastChatBody()!.conversation_id;

    // Verify localStorage has the cached messages
    const cached = await page.evaluate(
      (id) => localStorage.getItem(`chat_messages_${id}`),
      convId,
    );
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!);
    expect(parsed.length).toBeGreaterThan(0);
    // Should contain the assistant reply
    expect(
      parsed.some(
        (m: { type: string; content: string }) =>
          m.type === "assistant" && m.content === "Hello from Claude!",
      ),
    ).toBe(true);
  });

  test("MP-02 messages restored from localStorage when conversation has no sessionId", async ({
    page,
  }) => {
    const conversation = makeConversation({ title: "cached chat" });
    const convId = conversation.conversationId;

    // Pre-seed localStorage with cached messages for this conversation
    const cachedMessages = [
      {
        id: "msg-1",
        type: "user",
        content: "Cached user message",
        timestamp: Date.now(),
      },
      {
        id: "msg-2",
        type: "assistant",
        content: "Cached assistant reply",
        timestamp: Date.now(),
      },
    ];

    await page.addInitScript(
      (args: {
        convId: string;
        messages: { id: string; type: string; content: string; timestamp: number }[];
      }) => {
        localStorage.setItem(
          `chat_messages_${args.convId}`,
          JSON.stringify(args.messages),
        );
      },
      { convId, messages: cachedMessages },
    );

    await setupApp(page, { conversations: [conversation] });

    // Click the conversation — no sessionId, so transcript fetch won't return data
    await page.getByText("cached chat").click();

    // Messages should be restored from localStorage
    await expect(page.getByText("Cached user message")).toBeVisible();
    await expect(page.getByText("Cached assistant reply")).toBeVisible();
  });

  test("MP-03 server transcript takes priority over localStorage when sessionId exists", async ({
    page,
  }) => {
    const conversation = makeConversation({
      sessionId: "sess-priority",
      projectDir: "/home/ubuntu",
      title: "transcript chat",
    });
    const convId = conversation.conversationId;

    // Pre-seed localStorage with stale messages
    const staleMessages = [
      {
        id: "stale-1",
        type: "assistant",
        content: "Stale cached reply",
        timestamp: Date.now(),
      },
    ];

    await page.addInitScript(
      (args: {
        convId: string;
        messages: { id: string; type: string; content: string; timestamp: number }[];
      }) => {
        localStorage.setItem(
          `chat_messages_${args.convId}`,
          JSON.stringify(args.messages),
        );
      },
      { convId, messages: staleMessages },
    );

    await setupApp(page, {
      conversations: [conversation],
      transcripts: {
        "sess-priority": [
          {
            role: "user",
            content: [{ type: "text", text: "Fresh user question" }],
            isCompactSummary: false,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Fresh server reply" }],
            isCompactSummary: false,
          },
        ],
      },
    });

    // Click the conversation
    await page.getByText("transcript chat").click();

    // Server transcript messages should be shown
    await expect(page.getByText("Fresh user question")).toBeVisible();
    await expect(page.getByText("Fresh server reply")).toBeVisible();

    // Stale message should NOT be visible
    await expect(page.getByText("Stale cached reply")).not.toBeVisible();
  });

  test("MP-04 deleting a conversation cleans up its localStorage messages", async ({
    page,
  }) => {
    const conversation = makeConversation({ title: "to delete persist" });
    const convId = conversation.conversationId;

    // Pre-seed localStorage with cached messages
    await page.addInitScript(
      (args: { convId: string }) => {
        localStorage.setItem(
          `chat_messages_${args.convId}`,
          JSON.stringify([
            { id: "m1", type: "user", content: "hi", timestamp: Date.now() },
          ]),
        );
      },
      { convId },
    );

    await setupApp(page, { conversations: [conversation] });

    // Verify localStorage entry exists before delete
    const before = await page.evaluate(
      (id) => localStorage.getItem(`chat_messages_${id}`),
      convId,
    );
    expect(before).not.toBeNull();

    // Hover and click delete
    await page
      .locator(".group")
      .filter({ hasText: "to delete persist" })
      .hover();
    await page
      .locator(".group")
      .filter({ hasText: "to delete persist" })
      .locator("button")
      .click();

    // Conversation removed from sidebar
    await expect(page.getByText("to delete persist")).not.toBeVisible();

    // localStorage entry should be cleaned up
    const after = await page.evaluate(
      (id) => localStorage.getItem(`chat_messages_${id}`),
      convId,
    );
    expect(after).toBeNull();
  });
});
