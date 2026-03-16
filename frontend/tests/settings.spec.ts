/**
 * UF-23  Settings open      — clicking Settings opens the modal
 * UF-24  Settings X close   — clicking the X button closes the modal
 * UF-25  Settings backdrop  — clicking outside the modal closes it
 * UF-26  API key "Set" badge — shown when has_api_key is true
 * UF-27  Bedrock mode        — shows bedrock message instead of API key form
 * UF-28  Save API key        — saving shows success confirmation
 * UF-29  Save API key error  — server error shows failure message
 */
import { test, expect } from "@playwright/test";
import { setupApp } from "./helpers/setup";

test.describe("settings", () => {
  test("UF-23 clicking Settings opens the settings modal", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: false, base_url: null },
    });

    await page.getByTitle("Settings").click();

    await expect(page.getByText("Settings")).toBeVisible();
    await expect(page.getByText("API Key")).toBeVisible();
  });

  test("UF-24 clicking the X button closes the settings modal", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: false, base_url: null },
    });

    await page.getByTitle("Settings").click();
    await expect(page.getByText("API Key")).toBeVisible();

    // The X close button is the first button inside the modal card
    await page.locator(".max-w-md button").first().click();

    await expect(page.getByText("API Key")).not.toBeVisible();
  });

  test("UF-25 clicking the backdrop closes the settings modal", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: false, base_url: null },
    });

    await page.getByTitle("Settings").click();
    await expect(page.getByText("API Key")).toBeVisible();

    // Click at the top-left corner of the viewport — outside the centered modal
    await page.mouse.click(30, 30);

    await expect(page.getByText("API Key")).not.toBeVisible();
  });

  test("UF-26 shows Set badge when an API key is already configured", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: true, base_url: null },
    });

    await page.getByTitle("Settings").click();

    // Green "Set" badge appears next to the API Key label
    await expect(page.getByText("Set")).toBeVisible();
  });

  test("UF-27 shows Bedrock message when uses_bedrock is true", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: true, has_api_key: false, base_url: null },
    });

    await page.getByTitle("Settings").click();

    await expect(page.getByText(/AWS Bedrock/)).toBeVisible();
    // API key input is not shown in bedrock mode
    await expect(page.getByPlaceholder("sk-ant-…")).not.toBeVisible();
  });

  test("UF-28 saving an API key shows success message", async ({ page }) => {
    const ctrl = await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: false, base_url: null },
    });

    await page.getByTitle("Settings").click();
    await page.getByPlaceholder("sk-ant-…").fill("sk-ant-test-key-123");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("API key saved successfully.")).toBeVisible();
    expect(ctrl.lastSettingsSave()?.api_key).toBe("sk-ant-test-key-123");
  });

  test("UF-29 a server error when saving shows failure message", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: false, base_url: null },
      settingsSaveError: true,
    });

    await page.getByTitle("Settings").click();
    await page.getByPlaceholder("sk-ant-…").fill("sk-ant-test");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Failed to save. Please try again.")).toBeVisible();
  });
});
