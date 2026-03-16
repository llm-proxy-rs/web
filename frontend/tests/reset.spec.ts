/**
 * UF-45  Reset button hidden     — not rendered when hasUserRootfs is false
 * UF-46  Reset button visible    — rendered when hasUserRootfs is true
 * UF-47  Reset dialog opens      — clicking the button opens the confirmation dialog
 * UF-48  Reset dialog cancel     — clicking Cancel closes the dialog without navigation
 * UF-49  Reset form submits      — clicking Reset POSTs to /rootfs/delete with the CSRF token
 */
import { test, expect } from "@playwright/test";
import { setupApp, CSRF_TOKEN } from "./helpers/setup";

test.describe("reset environment", () => {
  test("UF-45 reset button is hidden when hasUserRootfs is false", async ({ page }) => {
    await setupApp(page, { hasUserRootfs: false });

    await expect(page.getByTitle("Reset environment")).not.toBeVisible();
  });

  test("UF-46 reset button is visible when hasUserRootfs is true", async ({ page }) => {
    await setupApp(page, { hasUserRootfs: true });

    await expect(page.getByTitle("Reset environment")).toBeVisible();
  });

  test("UF-47 clicking the reset button opens the confirmation dialog", async ({ page }) => {
    await setupApp(page, { hasUserRootfs: true });

    await page.getByTitle("Reset environment").click();

    await expect(page.getByText("Reset Environment?")).toBeVisible();
    await expect(page.getByText("This cannot be undone.")).toBeVisible();
  });

  test("UF-48 clicking Cancel closes the dialog without navigating", async ({ page }) => {
    await setupApp(page, { hasUserRootfs: true });

    await page.getByTitle("Reset environment").click();
    await expect(page.getByText("Reset Environment?")).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();

    // Dialog is gone and the app is still on the same page
    await expect(page.getByText("Reset Environment?")).not.toBeVisible();
    await expect(page.getByPlaceholder("Message Claude…")).toBeVisible();
  });

  test("UF-49 clicking Reset POSTs to /rootfs/delete with the CSRF token", async ({ page }) => {
    await setupApp(page, { hasUserRootfs: true });

    await page.getByTitle("Reset environment").click();
    await expect(page.getByText("Reset Environment?")).toBeVisible();

    const [request] = await Promise.all([
      page.waitForRequest("**/rootfs/delete"),
      page.getByRole("button", { name: "Reset", exact: true }).click(),
    ]);

    expect(request.method()).toBe("POST");
    expect(await request.headerValue("x-csrf-token")).toBe(CSRF_TOKEN);
  });
});
