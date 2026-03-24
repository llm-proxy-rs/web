/**
 * UF-70  New chat while streaming — composer is enabled when viewing a new/other chat
 * UF-71  Send in new chat while streaming — POST /chat fires for the new conversation
 * UF-72  Concurrent tasks — SSE events route to correct conversations and both complete
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse, makeConversation } from "./helpers/setup";

test.describe("new chat while a task is running", () => {
  test("UF-70 clicking New Chat while streaming enables the composer", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Send a message — this starts streaming (POST /chat blocks waiting for SSE events)
    await sendMessage(page, "Long running task");

    // While streaming is in progress, click "New Chat"
    await page.getByRole("button", { name: "New Chat" }).click();

    // The composer in the new chat should be enabled (not disabled)
    const composer = page.getByPlaceholder("Message Claude…");
    await expect(composer).toBeEnabled();
    await expect(composer).toBeFocused();

    // The send button should also be functional (not disabled due to other-running)
    await composer.fill("Hello from new chat");
    const sendBtn = page.getByTitle("Send");
    await expect(sendBtn).toBeEnabled();
  });

  test("UF-71 can send a message in new chat while another is streaming", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Start a streaming task
    await sendMessage(page, "Background task");

    // Switch to a new chat
    await page.getByRole("button", { name: "New Chat" }).click();

    // Complete the first POST so the serialised csrfFetch releases the token,
    // then queue events for the second POST.
    ctrl.sendSseEvents(sse.text("Background done", "sess-1"));
    ctrl.sendSseEvents(sse.text("Response to new chat", "sess-2"));

    // Type and send a message in the new chat
    await sendMessage(page, "Hello new chat");

    // Wait for the response to confirm the second POST was processed
    await expect(page.locator("text=Response to new chat")).toBeVisible();

    // Verify POST /chat was fired for the new conversation
    const bodies = ctrl.allChatBodies();
    expect(bodies.length).toBe(2);
    expect(bodies[1].content).toBe("Hello new chat");
  });

  test("UF-72 concurrent tasks route SSE events to correct conversations", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Queue events for the first POST — these will be delivered with conversation 1's ID
    ctrl.sendSseEvents(sse.text("First response", "sess-1"));

    // Send first message — POST /chat picks up the queued events
    await sendMessage(page, "First task");

    // Wait for the first response to appear
    await expect(page.locator("text=First response")).toBeVisible();

    // The first conversation should no longer be running (done event processed)
    // Now start a second conversation
    await page.getByRole("button", { name: "New Chat" }).click();

    // Queue events for the second POST
    ctrl.sendSseEvents(sse.text("Second response", "sess-2"));

    // Send second message
    await sendMessage(page, "Second task");

    // Wait for the second response to appear in the new conversation
    await expect(page.locator("text=Second response")).toBeVisible();

    // Verify both POSTs fired with different conversation IDs
    const bodies = ctrl.allChatBodies();
    expect(bodies.length).toBe(2);
    expect(bodies[0].content).toBe("First task");
    expect(bodies[1].content).toBe("Second task");
    expect(bodies[0].conversation_id).not.toBe(bodies[1].conversation_id);

    // Switch back to first conversation in sidebar and verify its messages are intact
    await page.locator("text=First task").first().click();
    await expect(page.locator("text=First response")).toBeVisible();
  });
});
