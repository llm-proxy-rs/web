/**
 * UF-53  Initial token sent      — first POST /chat carries the token from data-csrf-token
 * UF-54  Token rotated on send   — when server returns x-csrf-token, the next POST uses it
 * UF-55  Token rotated on delete — when server returns x-csrf-token, the next DELETE uses it
 * UF-57  Serialised CSRF fetch   — back-to-back POSTs use sequentially rotated tokens
 */
import { test, expect } from "@playwright/test";
import {
  setupApp,
  sendMessage,
  makeConversation,
  CSRF_TOKEN,
} from "./helpers/setup";

test.describe("csrf", () => {
  test("UF-53 first POST /chat carries the initial CSRF token from the page", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Pre-queue a done event so POST /chat can resolve immediately
    ctrl.sendSseEvents([
      { event: "done", data: { session_id: null, task_id: "t" } },
    ]);
    const responseReceived = page.waitForResponse("**/chat");
    await sendMessage(page, "Hello");
    await responseReceived;

    expect(ctrl.allChatBodies()[0].csrf_token).toBe(CSRF_TOKEN);
  });

  test("UF-54 next POST /chat uses the rotated token returned by the server", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // First send — server responds with a rotated token in the header; pre-queue done
    ctrl.setChatResponseToken("rotated-1");
    ctrl.sendSseEvents([
      { event: "done", data: { session_id: null, task_id: "t1" } },
    ]);
    const firstResponse = page.waitForResponse("**/chat");
    await sendMessage(page, "first message");
    await firstResponse;

    // Stream already completed (done was pre-queued), composer re-enables
    await expect(page.getByRole("status")).not.toBeVisible();

    // Second send — must carry the rotated token, not the original
    ctrl.sendSseEvents([
      { event: "done", data: { session_id: null, task_id: "t2" } },
    ]);
    const secondResponse = page.waitForResponse("**/chat");
    await sendMessage(page, "second message");
    await secondResponse;

    const bodies = ctrl.allChatBodies();
    expect(bodies[0].csrf_token).toBe(CSRF_TOKEN);
    expect(bodies[1].csrf_token).toBe("rotated-1");
  });

  test("UF-56 token rotated on model change — next POST /chat uses rotated token", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // Change the model — server responds with a rotated token
    ctrl.setSettingsResponseToken("rotated-settings-1");
    const settingsResponse = page.waitForResponse(
      (res) =>
        res.url().includes("/api/settings") && res.request().method() === "PUT",
    );
    // Open model chip dropdown and select a different model
    await page
      .locator("button", { hasText: /Sonnet/i })
      .first()
      .click();
    await page.locator("button", { hasText: "Opus" }).first().click();
    await settingsResponse;

    // Now send a chat message — must carry the rotated token, not the original
    ctrl.sendSseEvents([
      { event: "done", data: { session_id: null, task_id: "t1" } },
    ]);
    const chatResponse = page.waitForResponse("**/chat");
    await sendMessage(page, "after model change");
    await chatResponse;

    expect(ctrl.allChatBodies()[0].csrf_token).toBe("rotated-settings-1");
  });

  test("UF-55 DELETE /chat-transcript uses the rotated token after a send", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {
      conversations: [
        makeConversation({
          sessionId: "sess-del",
          projectDir: "/home/ubuntu",
          title: "to delete",
        }),
      ],
    });

    // Trigger a rotation via a chat send; pre-queue done so the response resolves
    ctrl.setChatResponseToken("rotated-1");
    ctrl.sendSseEvents([
      { event: "done", data: { session_id: null, task_id: "t" } },
    ]);
    const chatResponse = page.waitForResponse("**/chat");
    await sendMessage(page, "hi");
    await chatResponse;

    // Delete the conversation — should call DELETE /chat-transcript with rotated token
    const deleteResponse = page.waitForResponse(
      (res) =>
        res.url().includes("/chat-transcript") &&
        res.request().method() === "DELETE",
    );
    await page.locator(".group").filter({ hasText: "to delete" }).hover();
    await page
      .locator(".group")
      .filter({ hasText: "to delete" })
      .locator("button")
      .click();
    await deleteResponse;

    expect(ctrl.lastDeleteCsrfToken()).toBe("rotated-1");
  });

  test("UF-57 back-to-back sends use sequentially rotated tokens (no stale-token race)", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    // First send — server rotates token to "rotated-A"
    ctrl.setChatResponseToken("rotated-A");
    ctrl.sendSseEvents([
      { event: "done", data: { session_id: null, task_id: "t1" } },
    ]);
    const firstResponse = page.waitForResponse("**/chat");
    await sendMessage(page, "msg-1");
    await firstResponse;

    // Wait for composer to re-enable
    await expect(page.getByPlaceholder("Message Claude…")).toBeEnabled();

    // Start new chat and send immediately — server rotates token to "rotated-B"
    await page.getByRole("button", { name: "New Chat" }).click();
    ctrl.setChatResponseToken("rotated-B");
    ctrl.sendSseEvents([
      { event: "done", data: { session_id: null, task_id: "t2" } },
    ]);
    const secondResponse = page.waitForResponse("**/chat");
    await sendMessage(page, "msg-2");
    await secondResponse;

    // Both POSTs must use the correctly rotated token — no stale reuse
    const bodies = ctrl.allChatBodies();
    expect(bodies[0].csrf_token).toBe(CSRF_TOKEN);
    expect(bodies[1].csrf_token).toBe("rotated-A");
  });
});
