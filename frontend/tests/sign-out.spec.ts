/**
 * Sign out button tests:
 * - Sign out button is visible
 * - Clicking it sends POST /logout
 */
import { test, expect } from "@playwright/test";
import { setupApp } from "./helpers/setup";

test.describe("sign out", () => {
  test("sign out button is visible in the icon rail", async ({ page }) => {
    await setupApp(page, {});

    await expect(page.getByTitle("Sign out")).toBeVisible();
  });

  test("clicking sign out sends POST /logout", async ({ page }) => {
    await setupApp(page, {});

    // Intercept the /logout POST request
    let logoutPosted = false;
    await page.route("**/logout", async (route) => {
      logoutPosted = true;
      // Return a CSRF token in the response header (csrfFetch expects it)
      await route.fulfill({
        status: 200,
        headers: { "x-csrf-token": "new-token" },
        body: "",
      });
    });

    // Mock /login so the subsequent navigation doesn't error
    await page.route("**/login", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>Login</body></html>",
      }),
    );

    // Click sign out
    await page.getByTitle("Sign out").click();

    // Wait for the POST to complete
    await page.waitForTimeout(500);
    expect(logoutPosted).toBe(true);
  });
});
