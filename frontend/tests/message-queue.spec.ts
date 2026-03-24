/**
 * Message queue drawer — type and queue messages while Claude is streaming
 *
 * UF-80  Composer enabled during streaming — textarea is not disabled while loading
 * UF-81  Queued message appears in drawer — drawer shows queued text, not in chat bubbles
 * UF-82  Queued message auto-sends after response — next message dispatches when stream completes
 * UF-83  Multiple queued messages drain sequentially — each queued message sends after the previous finishes
 * UF-84  Placeholder changes during streaming — shows pending count when items are queued
 * UF-85  Stop button visible alongside send during streaming — both buttons present
 * UF-86  Queue clears on New Chat — switching to new chat discards the queue
 * UF-87  Remove a queued message via X button — clicking X removes item from drawer
 * UF-88  Clear all queued messages — "Clear all" button empties the queue
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("message queue", () => {
  test("UF-80 composer textarea is enabled during streaming", async ({
    page,
  }) => {
    await setupApp(page, {});

    await sendMessage(page, "Hello");

    const composer = page.locator("textarea");
    await expect(composer).toBeEnabled();
  });

  test("UF-81 queued message appears in drawer, not as chat bubble", async ({
    page,
  }) => {
    await setupApp(page, {});

    // Start streaming
    await sendMessage(page, "First message");
    await expect(page.getByRole("status")).toBeVisible();

    // Queue a second message
    await sendMessage(page, "Queued message");

    // The drawer header should appear
    await expect(page.getByText("Queued messages (1)")).toBeVisible();
    // The queued text should appear in the drawer
    await expect(
      page.locator(".fade-in-up").getByText("Queued message"),
    ).toBeVisible();

    // The queued message should NOT appear as a chat bubble in the messages pane
    // Only "First message" should be in the main area
    const mainMessages = page
      .getByRole("main")
      .locator('[class*="user"]')
      .filter({ hasText: "Queued message" });
    await expect(mainMessages).toHaveCount(0);
  });

  test("UF-82 queued message auto-sends after response completes", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "First");
    await sendMessage(page, "Second");

    // Drawer shows 1 queued
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // Complete the first stream
    ctrl.sendSseEvents(sse.text("Response to first", "sess-1"));
    await expect(page.getByText("Response to first")).toBeVisible();

    // The queued message should auto-dispatch
    ctrl.sendSseEvents(sse.text("Response to second", "sess-2"));
    await expect(page.getByText("Response to second")).toBeVisible();

    // Both POSTs should have fired
    const bodies = ctrl.allChatBodies();
    expect(bodies.length).toBe(2);
    expect(bodies[0].content).toBe("First");
    expect(bodies[1].content).toBe("Second");
  });

  test("UF-83 multiple queued messages drain sequentially", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "First");
    await sendMessage(page, "Second");
    await sendMessage(page, "Third");

    // Drawer should show 2 queued items
    await expect(page.getByText("Queued messages (2)")).toBeVisible();

    // Complete first stream → "Second" auto-dispatches
    ctrl.sendSseEvents(sse.text("R1", "sess-1"));
    await expect(page.getByText("R1")).toBeVisible();

    // Drawer should now show 1 queued item
    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    // Complete second stream → "Third" auto-dispatches
    ctrl.sendSseEvents(sse.text("R2", "sess-2"));
    await expect(page.getByText("R2")).toBeVisible();

    // Complete third stream
    ctrl.sendSseEvents(sse.text("R3", "sess-3"));
    await expect(page.getByText("R3")).toBeVisible();

    // All three POSTs fired
    const bodies = ctrl.allChatBodies();
    expect(bodies.length).toBe(3);
    expect(bodies[0].content).toBe("First");
    expect(bodies[1].content).toBe("Second");
    expect(bodies[2].content).toBe("Third");
  });

  test("UF-84 placeholder shows pending count when items are queued", async ({
    page,
  }) => {
    await setupApp(page, {});

    // Before sending — normal placeholder
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Message Claude…",
    );

    // Start streaming
    await sendMessage(page, "Hello");

    // During streaming with no queue — basic queue placeholder
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Type to queue a message…",
    );

    // Queue a message — placeholder shows count
    await sendMessage(page, "Queued");
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Type to queue a message (1 pending)…",
    );
  });

  test("UF-85 stop and send buttons both visible during streaming with input", async ({
    page,
  }) => {
    await setupApp(page, {});

    await sendMessage(page, "Hello");

    const composer = page.locator("textarea");
    await composer.fill("queued text");

    await expect(page.getByTitle("Stop (Esc)")).toBeVisible();
    await expect(page.getByTitle("Queue message")).toBeVisible();
  });

  test("UF-86 switching to New Chat clears the queue", async ({ page }) => {
    await setupApp(page, {});

    await sendMessage(page, "First");
    await sendMessage(page, "Queued");

    await expect(page.getByText("Queued messages (1)")).toBeVisible();

    await page.getByRole("button", { name: "New Chat" }).click();

    // Drawer should be gone
    await expect(page.getByText("Queued messages")).not.toBeVisible();
  });

  test("UF-87 clicking X removes a queued message from the drawer", async ({
    page,
  }) => {
    await setupApp(page, {});

    await sendMessage(page, "First");
    await sendMessage(page, "Remove me");
    await sendMessage(page, "Keep me");

    await expect(page.getByText("Queued messages (2)")).toBeVisible();

    // Click the X button on the first queued item ("Remove me")
    const removeButtons = page.locator('button[title="Remove from queue"]');
    await removeButtons.first().click();

    // Should now show 1 queued item
    await expect(page.getByText("Queued messages (1)")).toBeVisible();
    // "Remove me" should be gone, "Keep me" should remain
    await expect(page.getByText("Remove me")).not.toBeVisible();
    await expect(page.getByText("Keep me")).toBeVisible();
  });

  test("UF-88 clear all empties the queue", async ({ page }) => {
    await setupApp(page, {});

    await sendMessage(page, "First");
    await sendMessage(page, "Second queued");
    await sendMessage(page, "Third queued");

    await expect(page.getByText("Queued messages (2)")).toBeVisible();
    // "Clear all" button appears when there are 2+ items
    await page.getByText("Clear all").click();

    // Drawer should be gone
    await expect(page.getByText("Queued messages")).not.toBeVisible();
  });
});
