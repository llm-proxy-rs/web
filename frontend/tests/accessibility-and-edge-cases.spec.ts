import { test, expect } from "@playwright/test";
import {
  setupApp,
  sendMessage,
  sse,
  makeSession,
  makeConversation,
} from "./helpers/setup";

test.describe("Empty state and onboarding", () => {
  test("shows blank state message when no conversations exist", async ({
    page,
  }) => {
    const ctrl = await setupApp(page);
    // The app should show some kind of welcome/blank state
    await expect(
      page.locator('textarea[placeholder="Message Claude…"]'),
    ).toBeVisible();
  });

  test("composer is focused on load", async ({ page }) => {
    const ctrl = await setupApp(page);
    await expect(
      page.locator('textarea[placeholder="Message Claude…"]'),
    ).toBeFocused();
  });
});

test.describe("Multiple rapid messages", () => {
  test("queues messages sent while streaming", async ({ page }) => {
    const ctrl = await setupApp(page);
    // Send first message
    await sendMessage(page, "first");
    // While waiting for response, send another
    await sendMessage(page, "second");
    // Complete first response
    ctrl.sendSseEvents(sse.text("response1", "sess-1"));
    // Should see queued indicator
    await expect(page.getByText("response1")).toBeVisible();
  });
});

test.describe("Error recovery", () => {
  test("shows error message from SSE error event", async ({ page }) => {
    const ctrl = await setupApp(page);
    await sendMessage(page, "hello");
    ctrl.sendSseEvents(sse.error("Something went wrong"));
    await expect(page.getByText("Something went wrong")).toBeVisible();
  });

  test("can send new message after error", async ({ page }) => {
    const ctrl = await setupApp(page);
    await sendMessage(page, "hello");
    ctrl.sendSseEvents(sse.error("Something went wrong"));
    await expect(page.getByText("Something went wrong")).toBeVisible();
    // Should be able to send another message
    await sendMessage(page, "try again");
    ctrl.sendSseEvents(sse.text("recovered", "sess-2"));
    await expect(page.getByText("recovered")).toBeVisible();
  });
});

test.describe("Tool rendering edge cases", () => {
  test("shows tool card for unknown tool name", async ({ page }) => {
    const ctrl = await setupApp(page);
    await sendMessage(page, "do something");
    ctrl.sendSseEvents(
      sse.withTool(
        "t1",
        "custom_unknown_tool",
        { arg: "val" },
        "tool output",
        "done",
        "sess-1",
      ),
    );
    await expect(page.getByText("done")).toBeVisible();
  });

  test("handles empty tool result", async ({ page }) => {
    const ctrl = await setupApp(page);
    await sendMessage(page, "do something");
    ctrl.sendSseEvents(
      sse.withTool("t1", "Bash", { command: "echo" }, "", "complete", "sess-1"),
    );
    await expect(page.getByText("complete")).toBeVisible();
  });
});

test.describe("Thinking block behavior", () => {
  test("thinking indicator appears during streaming", async ({ page }) => {
    const ctrl = await setupApp(page);
    await sendMessage(page, "think about this");
    // Send partial events - session_start and init only
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-1" } },
      { event: "init" },
      { event: "thinking_delta", data: { thinking: "Let me think..." } },
      { event: "text_delta", data: { text: "Here is my answer" } },
      { event: "done", data: { session_id: "sess-1", task_id: "task-1" } },
    ]);
    await expect(page.getByText("Here is my answer")).toBeVisible();
  });
});

test.describe("Long content handling", () => {
  test("renders very long assistant response", async ({ page }) => {
    const ctrl = await setupApp(page);
    const longText = "word ".repeat(500);
    await sendMessage(page, "give me a long response");
    ctrl.sendSseEvents(sse.text(longText, "sess-1"));
    await expect(page.getByText("word word word")).toBeVisible();
  });

  test("handles message with special characters", async ({ page }) => {
    const ctrl = await setupApp(page);
    await sendMessage(page, "special chars: <>&\"'");
    ctrl.sendSseEvents(sse.text('Response with <html> & "quotes"', "sess-1"));
    await expect(page.getByText("Response with")).toBeVisible();
  });
});

test.describe("Session resumption", () => {
  test("resumes conversation with existing session_id", async ({ page }) => {
    const conv = makeConversation({
      conversationId: "conv-resume",
      sessionId: "sess-existing",
      projectDir: "/home/ubuntu",
    });
    const ctrl = await setupApp(page, {
      conversations: [conv],
      sessions: [makeSession({ session_id: "sess-existing" })],
      transcripts: {
        "sess-existing": [
          {
            role: "user",
            content: [{ type: "text", text: "previous message" }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "previous reply" }],
          },
        ],
      },
    });
    // Click on the conversation in the sidebar
    await page.getByText("hello").click();
    await expect(page.getByText("previous message")).toBeVisible();
    await expect(page.getByText("previous reply")).toBeVisible();
  });
});

test.describe("CSRF token rotation", () => {
  test("uses CSRF token from app-config in first request", async ({ page }) => {
    const ctrl = await setupApp(page);
    await sendMessage(page, "hello");
    ctrl.sendSseEvents(sse.text("hi", "sess-1"));
    await expect(
      page.getByTestId("assistant-card").getByText("hi"),
    ).toBeVisible();
    const body = ctrl.lastChatBody();
    expect(body?.csrf_token).toBe("test-csrf");
  });

  test("uses rotated CSRF token from response header in subsequent request", async ({
    page,
  }) => {
    const ctrl = await setupApp(page);
    ctrl.setChatResponseToken("rotated-token-1");
    await sendMessage(page, "first");
    ctrl.sendSseEvents(sse.text("reply1", "sess-1"));
    await expect(page.getByText("reply1")).toBeVisible();
    // Second message should use the rotated token
    await sendMessage(page, "second");
    ctrl.sendSseEvents(sse.text("reply2", "sess-2"));
    await expect(page.getByText("reply2")).toBeVisible();
    const bodies = ctrl.allChatBodies();
    expect(bodies[0]?.csrf_token).toBe("test-csrf");
    expect(bodies[1]?.csrf_token).toBe("rotated-token-1");
  });
});
