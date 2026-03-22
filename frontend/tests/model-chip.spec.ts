/**
 * Model chip/selector tests:
 * - Opens dropdown on click
 * - Selecting model sends PUT request
 * - Shows success/error feedback
 * - Outside click closes dropdown
 * - Displays current model
 */
import { test, expect } from "@playwright/test";
import { setupApp } from "./helpers/setup";

test.describe("model chip", () => {
  test("displays current model from settings", async ({ page }) => {
    await setupApp(page, {
      settings: { model: "opus" },
    });

    // The model chip should display the label for "opus"
    await expect(page.getByTitle("Change model")).toContainText("Opus");
  });

  test("opens dropdown on click", async ({ page }) => {
    await setupApp(page, {
      settings: { model: "sonnet" },
    });

    // Click the model chip
    await page.getByTitle("Change model").click();

    // The dropdown should show all model options
    await expect(page.getByText("Haiku")).toBeVisible();
    await expect(page.getByText("Opus", { exact: true })).toBeVisible();
  });

  test("selecting a model sends PUT /api/settings", async ({ page }) => {
    const ctrl = await setupApp(page, {
      settings: { model: "sonnet" },
    });

    // Open the dropdown
    await page.getByTitle("Change model").click();

    // Select Haiku — intercept the PUT request
    const [putReq] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/settings") && r.method() === "PUT"),
      page.getByText("Haiku").click(),
    ]);

    const body = JSON.parse(putReq.postData() ?? "{}") as { model?: string };
    expect(body.model).toBe("haiku");
  });

  test("shows success feedback after selecting a model", async ({ page }) => {
    await setupApp(page, {
      settings: { model: "sonnet" },
    });

    await page.getByTitle("Change model").click();
    await page.getByText("Haiku").click();

    // Success message "Updated" should appear
    await expect(page.getByText("Updated")).toBeVisible();
  });

  test("shows error feedback when save fails", async ({ page }) => {
    await setupApp(page, {
      settings: { model: "sonnet" },
      settingsSaveError: true,
    });

    await page.getByTitle("Change model").click();
    await page.getByText("Haiku").click();

    // Error message "Failed" should appear
    await expect(page.getByText("Failed")).toBeVisible();
  });

  test("outside click closes the dropdown", async ({ page }) => {
    await setupApp(page, {
      settings: { model: "sonnet" },
    });

    await page.getByTitle("Change model").click();
    await expect(page.getByText("Haiku")).toBeVisible();

    // Click outside the popover — top-left corner of viewport
    await page.mouse.click(30, 30);

    await expect(page.getByText("Haiku")).not.toBeVisible();
  });
});
