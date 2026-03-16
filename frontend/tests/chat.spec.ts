/**
 * UF-01  Blank new chat      — "Start a new conversation" shown when no conversations
 * UF-02  Send message        — user bubble + status bar appear
 * UF-03  Receive response    — assistant message shown, status bar gone, conversation in sidebar
 * UF-04  New Chat button     — clears to blank state
 * UF-05  New Chat + streaming — stays blank after done fires (not navigated away)
 * UF-59  New chat title      — sidebar shows first user message as title immediately
 * UF-60  Second new chat     — can create a second new chat after the first
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, makeSession, makeConversation, sse } from "./helpers/setup";

test.describe("chat", () => {
  test("UF-01 blank state shown on load with no conversations", async ({ page }) => {
    await setupApp(page, {});

    await expect(page.getByText("Start a new conversation")).toBeVisible();
    await expect(page.getByText("No conversations yet")).toBeVisible();
  });

  test("UF-02 sending a message shows user bubble and streaming status bar", async ({ page }) => {
    await setupApp(page, {});

    await sendMessage(page, "Hello Claude");

    // User's message bubble is immediately visible
    await expect(page.getByRole("main").getByText("Hello Claude")).toBeVisible();

    // ClaudeStatus bar appears while streaming (has role=status)
    await expect(page.getByRole("status")).toBeVisible();
  });

  test("UF-03 receiving response shows assistant message and conversation in sidebar", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hi");

    // Update the sessions list BEFORE sending done so that loadHistory()
    // (triggered by the done event) picks up the new session.
    ctrl.setSessions([makeSession({ session_id: "sess-1", title: "Hi" })]);
    ctrl.sendSseEvents(sse.text("Hello! How can I help?", "sess-1"));

    await expect(page.getByText("Hello! How can I help?")).toBeVisible();
    await expect(page.getByRole("status")).not.toBeVisible();
    // Conversation title "Hi" appears in the sidebar
    await expect(page.locator("span.truncate").filter({ hasText: /^Hi$/ })).toBeVisible();
  });

  test("UF-04 New Chat button resets to blank state", async ({ page }) => {
    await setupApp(page, {
      conversations: [makeConversation({ title: "hello" })],
    });

    // Click the existing conversation so we're viewing it
    await page.getByText("hello").click();
    // Now click New Chat
    await page.getByRole("button", { name: "New Chat" }).click();

    await expect(page.getByText("Start a new conversation")).toBeVisible();
    // No conversation highlighted in sidebar
    const activeRow = page.locator(".border-l-2.border-primary");
    await expect(activeRow).not.toBeVisible();
  });

  test("UF-05 clicking New Chat while streaming stays blank after done fires", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // 1. Send a message — stream is now "in flight" (no events sent yet)
    await sendMessage(page, "Hello");

    // 2. Click New Chat before the stream resolves
    await page.getByRole("button", { name: "New Chat" }).click();

    // 3. Now resolve the SSE stream (simulates done arriving after New Chat was clicked)
    ctrl.setSessions([makeSession({ session_id: "sess-2", title: "Hello" })]);
    ctrl.sendSseEvents(sse.text("Hi!", "sess-2"));

    // 4. The chat should remain blank — not navigated to the completed conversation
    await expect(page.getByText("Start a new conversation")).toBeVisible();
  });

  test("UF-59 sidebar shows first user message as title immediately after sending", async ({ page }) => {
    await setupApp(page, {});

    await sendMessage(page, "Tell me about cattle ranching");

    // Title appears in the sidebar immediately — before any SSE events arrive
    await expect(page.locator("span.truncate").filter({ hasText: "Tell me about cattle ranching" })).toBeVisible();
  });

  test("UF-60 can create a second new chat after the first", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    // Create first chat and complete its stream
    await sendMessage(page, "First message");
    ctrl.setSessions([makeSession({ session_id: "sess-1", title: "First message" })]);
    ctrl.sendSseEvents(sse.text("Response 1", "sess-1"));
    await expect(page.getByRole("status")).not.toBeVisible();

    // Click New Chat and send a second message
    await page.getByRole("button", { name: "New Chat" }).click();
    await expect(page.getByText("Start a new conversation")).toBeVisible();

    await sendMessage(page, "Second message");

    // Second conversation is created as a separate entry in the sidebar
    await expect(page.locator("span.truncate").filter({ hasText: "Second message" })).toBeVisible();
    // The first conversation is still in the sidebar
    await expect(page.locator("span.truncate").filter({ hasText: "First message" })).toBeVisible();
  });
});
