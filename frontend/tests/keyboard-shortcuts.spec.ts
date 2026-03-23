/**
 * Keyboard shortcuts:
 * - Escape key to stop streaming
 * - Number keys in question panel
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("keyboard shortcuts", () => {
  test("Escape key stops streaming when task_id is not yet available", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    // Send a message — stream is in flight, no SSE events yet
    await sendMessage(page, "Long running task");
    await expect(page.getByRole("status")).toBeVisible();

    // Press Escape — should abort the in-flight request
    await page.keyboard.press("Escape");

    // No /chat-stop POST because there's no task_id yet
    expect(ctrl.stopRequested()).toBe(false);

    // Composer should be re-enabled (streaming cleared)
    await expect(
      page.locator('textarea[placeholder="Message Claude…"]'),
    ).toBeEnabled();
  });

  test("number keys select question panel options as keyboard shortcuts", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Pick one");
    ctrl.sendSseEvents(
      sse.question("req-numkeys", [
        {
          question: "Which one?",
          options: [
            { label: "First" },
            { label: "Second" },
            { label: "Third" },
          ],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // Press "3" to select "Third"
    await page.keyboard.press("3");

    // Submit
    const [answerReq] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("chat-question-answer") && r.method() === "POST",
      ),
      page.getByRole("button", { name: "Submit" }).click(),
    ]);

    const body = JSON.parse(answerReq.postData() ?? "{}") as {
      answers: Record<string, string>;
    };
    expect(body.answers["Which one?"]).toBe("Third");
  });

  test("0 key toggles Other... option in question panel", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Choose");
    ctrl.sendSseEvents(
      sse.question("req-zero", [
        {
          question: "Preference?",
          options: [{ label: "Default" }],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // Press "0" to activate the Other... option
    await page.keyboard.press("0");

    // The free-text input should appear
    await expect(page.getByPlaceholder("Type your answer...")).toBeVisible();
  });
});
