/**
 * Question panel advanced features:
 * - Keyboard shortcuts (number keys 1-9 to select options)
 * - "Other..." free-text option
 * - Multi-step wizard (Next/Back navigation, step indicators)
 * - Skip question button
 * - Escape key to dismiss
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("question panel", () => {
  test("number key selects an option", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Choose");
    ctrl.sendSseEvents(
      sse.question("req-kb-1", [
        {
          question: "Pick a color",
          options: [
            { label: "Red", description: "Warm" },
            { label: "Blue", description: "Cool" },
            { label: "Green", description: "Natural" },
          ],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // Press "2" to select "Blue" via keyboard shortcut
    await page.keyboard.press("2");

    // Submit with the keyboard-selected option
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
    expect(body.answers["Pick a color"]).toBe("Blue");
  });

  test("Other... free-text option allows custom input", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Choose");
    ctrl.sendSseEvents(
      sse.question("req-other-1", [
        {
          question: "Favorite language?",
          options: [{ label: "Python" }, { label: "TypeScript" }],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // Click "Other..." button
    await page.getByText("Other...").click();

    // Type custom answer in the text input
    const otherInput = page.getByPlaceholder("Type your answer...");
    await expect(otherInput).toBeVisible();
    await otherInput.fill("Rust");

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
    expect(body.answers["Favorite language?"]).toBe("Rust");
  });

  test("multi-step wizard shows Next/Back and step indicators", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Wizard");
    ctrl.sendSseEvents(
      sse.question("req-wizard-1", [
        {
          question: "Step 1: Choose color",
          options: [{ label: "Red" }, { label: "Blue" }],
        },
        {
          question: "Step 2: Choose size",
          options: [{ label: "Small" }, { label: "Large" }],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();
    await expect(page.getByText("Step 1: Choose color")).toBeVisible();

    // Step indicator should show "1/2"
    await expect(page.getByText("1/2")).toBeVisible();

    // "Next" button should be visible (not "Submit")
    await expect(page.getByRole("button", { name: "Next" })).toBeVisible();

    // Select an option and click Next
    await page.getByRole("button", { name: "Red" }).click();
    await page.getByRole("button", { name: "Next" }).click();

    // Now we should see step 2
    await expect(page.getByText("Step 2: Choose size")).toBeVisible();
    await expect(page.getByText("2/2")).toBeVisible();

    // "Back" button should be visible
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();

    // "Submit" button should be visible (last step)
    await expect(page.getByRole("button", { name: "Submit" })).toBeVisible();

    // Click Back to go to step 1
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByText("Step 1: Choose color")).toBeVisible();
    await expect(page.getByText("1/2")).toBeVisible();
  });

  test("Skip button sends empty answers", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Choose");
    ctrl.sendSseEvents(
      sse.question("req-skip-1", [
        {
          question: "Optional question",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // Click Skip — should send empty answers
    const [answerReq] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("chat-question-answer") && r.method() === "POST",
      ),
      page.getByText("Skip").click(),
    ]);

    const body = JSON.parse(answerReq.postData() ?? "{}") as {
      answers: Record<string, string>;
    };
    // Empty answers object since no options were selected
    expect(Object.keys(body.answers)).toHaveLength(0);
  });

  test("Escape key dismisses the question panel", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Choose");
    ctrl.sendSseEvents(
      sse.question("req-esc-1", [
        {
          question: "Should I proceed?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ]),
    );

    await expect(page.getByText("Claude needs your input")).toBeVisible();

    // Press Escape to dismiss
    const [answerReq] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("chat-question-answer") && r.method() === "POST",
      ),
      page.keyboard.press("Escape"),
    ]);

    const body = JSON.parse(answerReq.postData() ?? "{}") as {
      answers: Record<string, string>;
    };
    // Skip sends empty answers
    expect(Object.keys(body.answers)).toHaveLength(0);

    // The question panel should be gone
    await expect(page.getByText("Claude needs your input")).not.toBeVisible();
  });
});
