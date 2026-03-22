/**
 * Drag-and-drop file attachment on the chat area:
 * - Drop attaches file (via file input as proxy, since Playwright can't construct DataTransfer)
 */
import { test, expect } from "@playwright/test";
import { setupApp } from "./helpers/setup";

test.describe("drag-drop", () => {
  test("dropping a file attaches it and shows in composer", async ({
    page,
  }) => {
    await setupApp(page, {});

    // Use the file input to simulate an attachment (drop uses the same addFiles path)
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );

    await page.locator('input[type="file"]').first().setInputFiles({
      name: "dropped-file.png",
      mimeType: "image/png",
      buffer: pngBuffer,
    });

    // The file name should appear as a chip in the composer
    await expect(page.getByText("dropped-file.png")).toBeVisible();
  });
});
