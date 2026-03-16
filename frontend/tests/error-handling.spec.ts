/**
 * UF-60  sendQuery network error   — POST /chat 503 adds an error message in chat and clears status bar
 * UF-61  answerQuestion network error — POST /chat-question-answer 500 dismisses the panel; no crash
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("error-handling", () => {
  test("UF-60 POST /chat 503 adds error message in chat and clears status bar", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [], chatError: "relay not available" });

    // The /chat route returns 503; sendQuery throws; handleSend catch adds a type:"error" message
    await sendMessage(page, "Hello");

    // The error content is String(err) = "Error: relay not available"
    await expect(page.getByText("Error: relay not available")).toBeVisible();

    // Status bar should be gone — setRunningSessionId(null) + setIsStreaming(false) were called
    await expect(page.getByRole("status")).not.toBeVisible();

    // Composer is re-enabled (isLoading is false)
    await expect(page.locator('textarea[placeholder="Message Claude…"]')).toBeEnabled();

    // No SSE events needed — the error was purely from the HTTP layer
    void ctrl;
  });

  test("UF-61 POST /chat-question-answer 500 dismisses the panel without crashing", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [], answerError: "internal error" });

    await sendMessage(page, "Help me choose");
    ctrl.sendSseEvents(
      sse.question("req-61", [
        {
          question: "Pick one?",
          options: [
            { label: "Yes", description: "Affirmative" },
            { label: "No", description: "Negative" },
          ],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();
    await page.getByRole("button", { name: "Yes" }).click();

    // Submit triggers: setSessionPendingQuestion(null) BEFORE await answerQuestion(...)
    // Panel dismisses immediately; the 500 is an unhandled rejection (no catch in handleAnswerQuestion)
    await page.getByRole("button", { name: "Submit" }).click();

    // Panel is gone
    await expect(page.getByText("Claude needs your input")).not.toBeVisible();

    // No error message in chat (the error is not caught and rendered — it is swallowed)
    await expect(page.getByText("Error:")).not.toBeVisible();
  });
});
