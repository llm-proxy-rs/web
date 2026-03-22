/**
 * DC-01  Terminal silently reconnects WS after disconnect
 * DC-02  No page reload on WS disconnect (silent reconnect instead)
 */
import { test, expect } from "@playwright/test";
import { setupApp } from "./helpers/setup";

test.describe("disconnect detection", () => {
  test("DC-01 terminal retries WS connection after disconnect", async ({
    page,
  }) => {
    let connectCount = 0;
    await page.routeWebSocket(/\/ws\//, (ws) => {
      connectCount++;
      if (connectCount === 1) {
        // First connection succeeds then drops
        setTimeout(() => ws.close(), 200);
      }
      // Subsequent connections stay open (new VM provisioned)
    });

    await setupApp(page, {});

    // Give time for initial connect → close → reconnect (1s backoff)
    await page.waitForTimeout(2500);

    // Should have attempted at least 2 connections
    expect(connectCount).toBeGreaterThanOrEqual(2);
  });

  test("DC-02 no page reload on WS disconnect", async ({ page }) => {
    await page.routeWebSocket(/\/ws\//, (ws) => {
      setTimeout(() => ws.close(), 200);
    });

    await setupApp(page, {});

    let reloaded = false;
    page.on("load", () => {
      reloaded = true;
    });

    // Wait past the old reload timeout (was 2s)
    await page.waitForTimeout(3000);

    expect(reloaded).toBe(false);
  });
});
