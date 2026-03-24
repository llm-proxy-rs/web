/**
 * CHL-01  History loads after VM becomes ready — conversations from /chat-history appear in sidebar
 *         when vmId transitions from "" to a real value (cold boot scenario).
 * CHL-02  localStorage conversations restored after vmId arrives — pre-seeded conversations
 *         appear once vmId is set.
 */
import { test, expect } from "@playwright/test";
import { setupApp, makeSession, VM_ID } from "./helpers/setup";

test.describe("conversation history load on boot", () => {
  test("CHL-01 server history loads after VM becomes ready", async ({
    page,
  }) => {
    let pollCount = 0;

    await page.route("**/api/vm-status", (route) => {
      pollCount++;
      if (pollCount >= 2) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ready",
            vm_id: VM_ID,
            has_user_rootfs: false,
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "provisioning" }),
      });
    });

    // Route WS so terminal doesn't error
    await page.routeWebSocket(/\/ws\b/, () => {});

    // Set up with existing server sessions but vmId="" (cold boot)
    await setupApp(page, {
      vmId: "",
      sessions: [
        makeSession({ session_id: "sess-1", title: "Previous chat" }),
        makeSession({ session_id: "sess-2", title: "Another old chat" }),
      ],
    });

    // Initially shows loading spinner, no conversations visible
    await expect(page.getByText("Starting environment")).toBeVisible();

    // After VM becomes ready, composer should appear
    await expect(page.getByPlaceholder("Message Claude…")).toBeVisible({
      timeout: 10000,
    });

    // Server-side conversation history should now be synced into the sidebar
    await expect(
      page.locator("span.truncate").filter({ hasText: "Previous chat" }),
    ).toBeVisible();
    await expect(
      page.locator("span.truncate").filter({ hasText: "Another old chat" }),
    ).toBeVisible();
  });

  test("CHL-02 localStorage conversations restored after vmId arrives", async ({
    page,
  }) => {
    let pollCount = 0;

    await page.route("**/api/vm-status", (route) => {
      pollCount++;
      if (pollCount >= 2) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ready",
            vm_id: VM_ID,
            has_user_rootfs: false,
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "provisioning" }),
      });
    });

    // Route WS so terminal doesn't error
    await page.routeWebSocket(/\/ws\b/, () => {});

    // Pre-seed localStorage with conversations keyed by the real vmId
    // (simulates a previous session that saved conversations before reboot).
    await setupApp(page, {
      vmId: "",
      conversations: [
        {
          conversationId: "conv-local-1",
          sessionId: "sess-local-1",
          title: "Saved local chat",
          createdAt: Date.now(),
        },
      ],
    });

    // Initially shows loading spinner
    await expect(page.getByText("Starting environment")).toBeVisible();

    // Wait for VM to become ready
    await expect(page.getByPlaceholder("Message Claude…")).toBeVisible({
      timeout: 10000,
    });

    // The localStorage conversation should be restored once vmId is set
    await expect(
      page.locator("span.truncate").filter({ hasText: "Saved local chat" }),
    ).toBeVisible();
  });
});
