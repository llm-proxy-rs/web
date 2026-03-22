/**
 * File download tests:
 * - Clicking a file triggers download
 * - Directory row has download-as-zip link
 */
import { test, expect } from "@playwright/test";
import { setupApp } from "./helpers/setup";

test.describe("file download", () => {
  test("clicking a file triggers download with correct path", async ({
    page,
  }) => {
    await setupApp(page, {
      files: {
        "/tmp": [{ name: "readme.txt", is_dir: false, size: 1024 }],
      },
    });

    // Open the Files panel
    await page.getByTitle("Files").click();
    await expect(page.getByText("readme.txt")).toBeVisible();

    // Intercept window.open before clicking
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__openedUrl = "";
      const origOpen = window.open;
      window.open = (url?: string | URL, ...args: unknown[]) => {
        (window as unknown as Record<string, unknown>).__openedUrl = String(
          url ?? "",
        );
        return null;
      };
    });

    // Click the file row
    await page.getByText("readme.txt").click();

    // Check the intercepted URL
    const openedUrl = await page.evaluate(
      () => (window as unknown as Record<string, string>).__openedUrl,
    );
    expect(openedUrl).toContain("/download?path=");
    expect(openedUrl).toContain("readme.txt");
  });

  test("directory row shows a download-as-zip link", async ({ page }) => {
    await setupApp(page, {
      files: {
        "/tmp": [{ name: "my-folder", is_dir: true, size: 0 }],
      },
    });

    // Open the Files panel
    await page.getByTitle("Files").click();
    await expect(page.getByText("my-folder")).toBeVisible();

    // Hover to reveal download icon
    await page.getByText("my-folder").hover();

    // The zip download link should exist with the correct href
    const downloadLink = page.locator('a[title="Download as zip"]');
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute("href");
    expect(href).toContain("/download?path=");
    expect(href).toContain("my-folder");
  });
});
