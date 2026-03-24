/**
 * Message queue — type and queue messages while Claude is streaming
 *
 * UF-80  Composer enabled during streaming — textarea is not disabled while loading
 * UF-81  Queue a message during streaming — user message appears immediately, queued badge shows
 * UF-82  Queued message auto-sends after response — next message dispatches when stream completes
 * UF-83  Multiple queued messages drain sequentially — each queued message sends after the previous finishes
 * UF-84  Placeholder changes during streaming — shows "Type to queue a message…" while loading
 * UF-85  Stop button visible alongside send during streaming — both buttons present
 * UF-86  Queue clears on New Chat — switching to new chat discards the queue
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("message queue", () => {
  test("UF-80 composer textarea is enabled during streaming", async ({
    page,
  }) => {
    await setupApp(page, {});

    // Send a message — stream starts (no events sent so it stays loading)
    await sendMessage(page, "Hello");

    // The textarea should still be enabled (not disabled)
    const composer = page.locator("textarea");
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveAttribute(
      "placeholder",
      "Type to queue a message…",
    );
  });

  test("UF-81 queued message appears in chat immediately with badge", async ({
    page,
  }) => {
    await setupApp(page, {});

    // Start streaming
    await sendMessage(page, "First message");

    // Status bar should be visible (streaming)
    await expect(page.getByRole("status")).toBeVisible();

    // Type and send another message while streaming
    await sendMessage(page, "Queued message");

    // The queued user message should appear in the chat immediately
    await expect(
      page.getByRole("main").getByText("Queued message"),
    ).toBeVisible();

    // A badge showing "1" should appear (queued count)
    await expect(page.locator("span").filter({ hasText: /^1$/ })).toBeVisible();
  });

  test("UF-82 queued message auto-sends after response completes", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Start streaming
    await sendMessage(page, "First");

    // Queue a second message while streaming
    await sendMessage(page, "Second");

    // Complete the first stream
    ctrl.sendSseEvents(sse.text("Response to first", "sess-1"));
    await expect(page.getByText("Response to first")).toBeVisible();

    // The queued message should auto-dispatch — queue events for it
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

    // Start streaming
    await sendMessage(page, "First");

    // Queue two more messages
    await sendMessage(page, "Second");
    await sendMessage(page, "Third");

    // Badge should show "2"
    await expect(page.locator("span").filter({ hasText: /^2$/ })).toBeVisible();

    // Complete first stream → "Second" auto-dispatches
    ctrl.sendSseEvents(sse.text("R1", "sess-1"));
    await expect(page.getByText("R1")).toBeVisible();

    // Badge should now show "1"
    await expect(page.locator("span").filter({ hasText: /^1$/ })).toBeVisible();

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

  test("UF-84 placeholder changes during streaming", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    // Before sending — normal placeholder
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Message Claude…",
    );

    // Start streaming
    await sendMessage(page, "Hello");

    // During streaming — queue placeholder
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Type to queue a message…",
    );

    // Complete stream — back to normal
    ctrl.sendSseEvents(sse.text("Hi", "sess-1"));
    await expect(page.getByRole("status")).not.toBeVisible();
    await expect(page.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Message Claude…",
    );
  });

  test("UF-85 stop and send buttons both visible during streaming with input", async ({
    page,
  }) => {
    await setupApp(page, {});

    await sendMessage(page, "Hello");

    // Type something in the composer while streaming
    const composer = page.locator("textarea");
    await composer.fill("queued text");

    // Both stop and send buttons should be visible
    await expect(page.getByTitle("Stop (Esc)")).toBeVisible();
    await expect(page.getByTitle("Queue message")).toBeVisible();
  });

  test("UF-86 switching to New Chat clears the queue", async ({ page }) => {
    await setupApp(page, {});

    // Start streaming and queue a message
    await sendMessage(page, "First");
    await sendMessage(page, "Queued");

    // Badge visible
    await expect(page.locator("span").filter({ hasText: /^1$/ })).toBeVisible();

    // Click New Chat
    await page.getByRole("button", { name: "New Chat" }).click();

    // Queue badge should be gone
    await expect(
      page.locator("span").filter({ hasText: /^1$/ }),
    ).not.toBeVisible();
  });
});
