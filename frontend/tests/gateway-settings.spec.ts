/**
 * UF-32  Gateway mode shows Renew button   — shows "Renew API Key" instead of manual input
 * UF-33  Gateway mode hides manual input    — no text input or Save button visible
 * UF-34  Gateway renew success              — clicking Renew shows success message
 * UF-35  Gateway renew error                — server error shows failure message
 * UF-36  Gateway renew redirect             — server redirect triggers navigation
 * UF-37  Gateway Set badge with renew       — shows Set badge when has_api_key is true
 * UF-38  Non-gateway mode unchanged         — manual input still shown when gateway not configured
 */
import { test, expect } from "@playwright/test";
import { setupApp } from "./helpers/setup";

test.describe("gateway settings", () => {
  test("UF-32 shows Renew API Key button when gateway is configured", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: false, base_url: null, gateway_configured: true },
    });

    await page.getByTitle("Settings").click();

    await expect(page.getByRole("button", { name: "Renew API Key" })).toBeVisible();
    await expect(page.getByText("Your API key is managed automatically")).toBeVisible();
  });

  test("UF-33 hides manual API key input when gateway is configured", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: false, base_url: null, gateway_configured: true },
    });

    await page.getByTitle("Settings").click();

    await expect(page.getByPlaceholder("sk-ant-…")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).not.toBeVisible();
  });

  test("UF-34 clicking Renew API Key shows success message", async ({ page }) => {
    const ctrl = await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: true, base_url: null, gateway_configured: true },
    });

    await page.getByTitle("Settings").click();
    await page.getByRole("button", { name: "Renew API Key" }).click();

    await expect(page.getByText("API key renewed successfully.")).toBeVisible();
    expect(ctrl.renewGatewayKeyRequested()).toBe(true);
  });

  test("UF-35 server error when renewing shows failure message", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: true, base_url: null, gateway_configured: true },
      renewGatewayKeyError: true,
    });

    await page.getByTitle("Settings").click();
    await page.getByRole("button", { name: "Renew API Key" }).click();

    await expect(page.getByText("Failed to renew. Please try again.")).toBeVisible();
  });

  test("UF-36 server redirect response triggers navigation", async ({ page }) => {
    const ctrl = await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: false, base_url: null, gateway_configured: true },
      renewGatewayKeyRedirect: "https://auth.example.com/oauth2/authorize?client_id=test",
    });

    await page.getByTitle("Settings").click();
    await page.getByRole("button", { name: "Renew API Key" }).click();

    // The renew endpoint was called
    expect(ctrl.renewGatewayKeyRequested()).toBe(true);

    // No success/error messages should appear since the page should navigate away
    await expect(page.getByText("API key renewed successfully.")).not.toBeVisible();
    await expect(page.getByText("Failed to renew.")).not.toBeVisible();
  });

  test("UF-37 shows Set badge when gateway configured and has_api_key is true", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: true, base_url: null, gateway_configured: true },
    });

    await page.getByTitle("Settings").click();

    await expect(page.getByText("Set", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Renew API Key" })).toBeVisible();
  });

  test("UF-38 manual input still shown when gateway is not configured", async ({ page }) => {
    await setupApp(page, {
      settings: { uses_bedrock: false, has_api_key: false, base_url: null, gateway_configured: false },
    });

    await page.getByTitle("Settings").click();

    await expect(page.getByPlaceholder("sk-ant-…")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Renew API Key" })).not.toBeVisible();
  });
});
