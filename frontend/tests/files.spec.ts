/**
 * UF-18  Empty directory     — Files tab shows "Empty directory" when no entries
 * UF-19  File listing        — Files tab lists file names and formatted sizes
 * UF-20  Navigate into dir   — clicking a directory loads its contents
 * UF-21  Breadcrumb nav      — clicking Home in breadcrumb returns to root
 * UF-22  File upload         — selecting a file shows "Uploading…" then "Uploaded."
 */
import { test, expect } from "@playwright/test";
import { setupApp } from "./helpers/setup";

test.describe("files", () => {
  test("UF-18 empty directory shows empty state", async ({ page }) => {
    await setupApp(page, { files: { "/tmp": [] } });

    await page.getByTitle("Files").click();

    await expect(page.getByText("Empty directory")).toBeVisible();
  });

  test("UF-19 file listing shows names and formatted sizes", async ({ page }) => {
    await setupApp(page, {
      files: {
        "/tmp": [
          { name: "report.txt", is_dir: false, size: 2048 },
          { name: "data.csv", is_dir: false, size: 102400 },
          { name: "images", is_dir: true, size: 0 },
        ],
      },
    });

    await page.getByTitle("Files").click();

    await expect(page.getByText("report.txt")).toBeVisible();
    await expect(page.getByText("2.0 KB")).toBeVisible();
    await expect(page.getByText("data.csv")).toBeVisible();
    await expect(page.getByText("100.0 KB")).toBeVisible();
    // Directory entry shown (no size displayed for dirs)
    await expect(page.getByText("images")).toBeVisible();
  });

  test("UF-20 clicking a directory navigates into it", async ({ page }) => {
    await setupApp(page, {
      files: {
        "/tmp": [{ name: "docs", is_dir: true, size: 0 }],
        "/tmp/docs": [{ name: "readme.md", is_dir: false, size: 512 }],
      },
    });

    await page.getByTitle("Files").click();

    // Click the "docs" folder
    await page.getByText("docs").click();

    // Inside /tmp/docs — readme.md is visible
    await expect(page.getByText("readme.md")).toBeVisible();
    // The parent dir back-link appears
    await expect(page.getByText("..")).toBeVisible();
  });

  test("UF-21 clicking Home in breadcrumb navigates back to root", async ({ page }) => {
    await setupApp(page, {
      files: {
        "/tmp": [{ name: "logs", is_dir: true, size: 0 }],
        "/tmp/logs": [{ name: "app.log", is_dir: false, size: 1024 }],
      },
    });

    await page.getByTitle("Files").click();

    // Navigate into the logs directory
    await page.getByText("logs").click();
    await expect(page.getByText("app.log")).toBeVisible();

    // Click the "Home" breadcrumb link to go back to /tmp
    await page.getByRole("button", { name: "Home" }).click();

    await expect(page.getByText("logs")).toBeVisible();
    await expect(page.getByText("app.log")).not.toBeVisible();
  });

  test("UF-22 uploading a file shows status and then clears", async ({ page }) => {
    await setupApp(page, { files: { "/tmp": [] } });

    await page.getByTitle("Files").click();
    // Wait for the FileManager to finish its initial directory load
    await expect(page.getByText("Empty directory")).toBeVisible();

    // Set files directly on the hidden input — avoids relying on the OS file chooser dialog
    await page.locator('input[type="file"]').setInputFiles({
      name: "test.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });

    // "Uploading…" banner appears immediately
    await expect(page.getByText("Uploading…")).toBeVisible();
    // After the mock upload completes, banner updates to "Uploaded."
    await expect(page.getByText("Uploaded.")).toBeVisible();
  });
});
