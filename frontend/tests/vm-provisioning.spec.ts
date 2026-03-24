/**
 * VP-01  Loading spinner shown when vmId is empty
 * VP-02  Polls /api/vm-status and transitions to ready
 * VP-03  IconRail is accessible during loading
 * VP-04  Terminal WS not opened until vmId is set
 */
import { test, expect } from "@playwright/test";
import { setupApp, VM_ID } from "./helpers/setup";

test.describe("vm provisioning", () => {
  test("VP-01 shows loading spinner when vmId is empty", async ({ page }) => {
    // Mock vm-status to always return provisioning
    await page.route("**/api/vm-status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "provisioning" }),
      }),
    );

    await setupApp(page, { vmId: "" });

    await expect(page.getByText("Starting environment")).toBeVisible();
    // Composer should NOT be visible
    await expect(page.getByPlaceholder("Message Claude…")).not.toBeVisible();
  });

  test("VP-02 polls vm-status and transitions to ready", async ({ page }) => {
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

    await setupApp(page, { vmId: "" });

    // Initially shows spinner
    await expect(page.getByText("Starting environment")).toBeVisible();

    // After polling returns ready, composer should appear
    await expect(page.getByPlaceholder("Message Claude…")).toBeVisible({
      timeout: 10000,
    });

    // Spinner should be gone
    await expect(page.getByText("Starting environment")).not.toBeVisible();

    // Should have polled at least twice
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  test("VP-03 IconRail accessible during loading", async ({ page }) => {
    await page.route("**/api/vm-status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "provisioning" }),
      }),
    );

    await setupApp(page, { vmId: "", hasUserRootfs: true });

    // Loading spinner is shown
    await expect(page.getByText("Starting environment")).toBeVisible();

    // IconRail buttons should still be accessible
    await expect(page.getByTitle("Settings")).toBeVisible();
  });

  test("VP-04 terminal WS not opened until vmId is set", async ({ page }) => {
    let wsConnected = false;

    await page.routeWebSocket(/\/ws\b/, () => {
      wsConnected = true;
    });

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

    await setupApp(page, { vmId: "" });

    // During loading, no WS should be connected
    expect(wsConnected).toBe(false);

    // Wait for VM to become ready
    await expect(page.getByPlaceholder("Message Claude…")).toBeVisible({
      timeout: 10000,
    });

    // Now switch to terminal tab to trigger WS
    await page.getByTitle("Terminal").click();
    await page.waitForTimeout(500);

    // WS should now be connected
    expect(wsConnected).toBe(true);
  });

  test("VP-05 reset button appears after provisioning with has_user_rootfs", async ({
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
            has_user_rootfs: true,
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "provisioning" }),
      });
    });

    await page.routeWebSocket(/\/ws\b/, () => {});

    await setupApp(page, { vmId: "", hasUserRootfs: false });

    // Initially no reset button (hasUserRootfs is false)
    await expect(page.getByTitle("Reset environment")).not.toBeVisible();

    // After polling returns ready with has_user_rootfs: true, button should appear
    await expect(page.getByTitle("Reset environment")).toBeVisible({
      timeout: 10000,
    });
  });
});
