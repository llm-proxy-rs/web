/**
 * UF-11  Resume conversation   — clicking conversation in sidebar loads its transcript
 * UF-12  Tool results resume   — tool cards from transcript include result
 * UF-13  Delete conversation   — hovering + clicking trash removes conversation
 * UF-14  Refresh button        — clicking Refresh imports server sessions not yet in local conversations
 */
import { test, expect } from "@playwright/test";
import { setupApp, makeConversation, makeSession } from "./helpers/setup";

test.describe("session", () => {
  test("UF-11 clicking a conversation in the sidebar loads its transcript", async ({ page }) => {
    const conversation = makeConversation({ sessionId: "sess-abc", projectDir: "/home/ubuntu", title: "my chat" });

    await setupApp(page, {
      conversations: [conversation],
      transcripts: {
        "sess-abc": [
          {
            role: "user",
            content: [{ type: "text", text: "What is 2+2?" }],
            isCompactSummary: false,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "It is 4." }],
            isCompactSummary: false,
          },
        ],
      },
    });

    // Conversation appears in sidebar; click it
    await page.getByText("my chat").click();

    // Transcript messages are shown
    await expect(page.getByText("What is 2+2?")).toBeVisible();
    await expect(page.getByText("It is 4.")).toBeVisible();

    // Conversation row is highlighted
    const activeRow = page.locator(".border-l-2.border-primary");
    await expect(activeRow).toBeVisible();
  });

  test("UF-12 tool results are shown when resuming a conversation from transcript", async ({
    page,
  }) => {
    const conversation = makeConversation({ sessionId: "sess-tool", projectDir: "/home/ubuntu", title: "tool session" });

    await setupApp(page, {
      conversations: [conversation],
      transcripts: {
        "sess-tool": [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call-1",
                name: "Bash",
                input: { command: "echo hello" },
              },
            ],
            isCompactSummary: false,
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: "hello",
                is_error: false,
              },
            ],
            isCompactSummary: false,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "All done." }],
            isCompactSummary: false,
          },
        ],
      },
    });

    await page.getByText("tool session").click();

    // Tool card is visible with its name
    await expect(page.getByText("Bash")).toBeVisible();
    // Tool result is shown in the card
    await expect(page.getByText("hello")).toBeVisible();
    // Follow-up text visible
    await expect(page.getByText("All done.")).toBeVisible();
  });

  test("UF-13 hovering a conversation and clicking delete removes it from the list", async ({
    page,
  }) => {
    const conversation = makeConversation({ title: "to be deleted" });

    await setupApp(page, { conversations: [conversation] });

    // Reveal the delete button by hovering the conversation row
    await page.locator(".group").filter({ hasText: "to be deleted" }).hover();

    // Click the trash icon button inside the row
    await page
      .locator(".group")
      .filter({ hasText: "to be deleted" })
      .locator("button")
      .click();

    // Conversation is no longer visible in the sidebar
    await expect(page.getByText("to be deleted")).not.toBeVisible();
    await expect(page.getByText("No conversations yet")).toBeVisible();
  });

  test("UF-14 clicking Refresh imports server sessions not yet in local conversations", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Initially no sessions on the server → sidebar is empty
    await expect(page.getByText("No conversations yet")).toBeVisible();

    // Add a server session, then click Refresh
    ctrl.setSessions([makeSession({ session_id: "sess-new", title: "Imported session" })]);
    await page.getByTitle("Refresh conversations").click();

    // The imported session now appears in the sidebar
    await expect(page.locator("span.truncate").filter({ hasText: "Imported session" })).toBeVisible();
  });
});
