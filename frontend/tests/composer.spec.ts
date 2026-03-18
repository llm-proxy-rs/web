/**
 * UF-30  Shift+Enter        — inserts newline in composer without submitting
 * UF-31  SSE error event    — error message shown in chat, streaming cleared
 * UF-32  Copy button hover  — hovering an assistant message reveals copy button
 * UF-33  Code block copy    — code blocks show language header and copy button
 * UF-56  New Chat auto-focus — clicking "New Chat" puts focus on the composer textarea
 * UF-57  Post-send focus    — after sending a message the composer textarea regains focus
 * UF-58  Session select focus — switching to a history session focuses the composer textarea
 * UF-61  New Chat from blank focuses composer — clicking "New Chat" when already on blank state focuses composer
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse, makeConversation } from "./helpers/setup";

test.describe("composer", () => {
  test("UF-30 Shift+Enter inserts a newline without submitting", async ({ page }) => {
    await setupApp(page, {});

    const composer = page.getByPlaceholder("Message Claude…");
    await composer.click();
    await composer.type("line1");
    await composer.press("Shift+Enter");
    await composer.type("line2");

    // No status bar — message was not submitted
    await expect(page.getByRole("status")).not.toBeVisible();

    // Composer contains a newline separating the two lines
    const value = await composer.inputValue();
    expect(value).toBe("line1\nline2");
  });

  test("UF-31 SSE error event shows an error message in the chat", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Do something");
    ctrl.sendSseEvents([
      { event: "init" },
      { event: "error_event", data: { message: "Something went wrong on the server" } },
    ]);

    // Error text appears in the chat
    await expect(page.getByText("Something went wrong on the server")).toBeVisible();
    // Streaming state is cleared — status bar gone
    await expect(page.getByRole("status")).not.toBeVisible();
  });

  test("UF-32 hovering an assistant message reveals the copy button", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Here is my response.", "sess-1"));

    await expect(page.getByText("Here is my response.")).toBeVisible();

    // Before hovering — copy button is NOT in the DOM (no invisible block)
    await expect(page.getByTitle("Copy", { exact: true })).not.toBeVisible();

    // Hover over the message text — the copy button becomes visible
    await page.getByText("Here is my response.").hover();
    await expect(page.getByTitle("Copy", { exact: true })).toBeVisible();
  });

  test("UF-33 code block shows language header and copy button", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Show me code");
    ctrl.sendSseEvents(sse.text("Here is code:\n\n```python\nprint('hello')\n```", "sess-code"));

    // Code content visible
    await expect(page.getByText("print('hello')")).toBeVisible();
    // Language label in code block header
    await expect(page.getByText("python")).toBeVisible();
    // Copy button in code block header
    await expect(page.getByTitle("Copy code")).toBeVisible();
  });

  test("UF-56 clicking New Chat focuses the composer textarea", async ({ page }) => {
    await setupApp(page, {
      conversations: [makeConversation({ title: "Old chat" })],
    });

    // Navigate away to an existing conversation
    await page.getByText("Old chat").click();

    // Click "New Chat" in the sidebar
    await page.getByRole("button", { name: "New Chat" }).click();

    // The textarea should have focus immediately
    const composer = page.getByPlaceholder("Message Claude…");
    await expect(composer).toBeFocused();
  });

  test("UF-57 composer textarea regains focus after sending a message", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");

    // Complete the stream so loading ends and the composer re-enables
    ctrl.sendSseEvents(sse.text("Hi there", "sess-1"));
    await expect(page.getByRole("status")).not.toBeVisible();

    const composer = page.getByPlaceholder("Message Claude…");
    await expect(composer).toBeFocused();
  });

  test("UF-58 switching to a history session focuses the composer textarea", async ({ page }) => {
    await setupApp(page, {
      conversations: [makeConversation({ title: "Past chat" })],
    });

    await page.getByText("Past chat").click();

    const composer = page.getByPlaceholder("Message Claude…");
    await expect(composer).toBeFocused();
  });

  test("UF-61 clicking New Chat when already on blank state focuses the composer textarea", async ({ page }) => {
    // Load with no conversations — selectedConversation starts as null
    await setupApp(page, {});

    // Click somewhere else first to lose focus
    await page.getByText("Start a new conversation").click();

    // Click New Chat — selectedConversation stays null but newChatKey increments,
    // which must still trigger focus even without a selectedConversation state change
    await page.getByRole("button", { name: "New Chat" }).click();

    const composer = page.getByPlaceholder("Message Claude…");
    await expect(composer).toBeFocused();
  });
});
