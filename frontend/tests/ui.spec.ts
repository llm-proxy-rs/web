/**
 * UF-15  Dark mode toggle   — clicking toggle applies light mode
 * UF-16  Tab navigation     — Terminal and Files tabs show correct panels
 * UF-17  Slash commands     — typing "/" opens menu; selecting fills composer
 */
import { test, expect } from "@playwright/test";
import { setupApp } from "./helpers/setup";

test.describe("ui", () => {
  test("UF-15 dark mode toggle switches to light mode", async ({ page }) => {
    await setupApp(page);

    // App starts in dark mode. The toggle title is "Light mode" (click to switch to light)
    // or "Dark mode" (click to switch to dark). Check which is present.
    const toggle = page.getByTitle("Light mode");
    await toggle.click();

    // Light mode: toggle now shows "Dark mode" option
    await expect(page.getByTitle("Dark mode")).toBeVisible();

    // Clicking again restores dark mode
    await page.getByTitle("Dark mode").click();
    await expect(page.getByTitle("Light mode")).toBeVisible();
  });

  test("UF-16 tab navigation shows correct panels", async ({ page }) => {
    await setupApp(page);

    // Chat tab is active by default — composer is visible
    const composer = page.getByPlaceholder("Message Claude…");
    await expect(composer).toBeVisible();

    // Navigate to Terminal tab
    const terminalTab = page.getByTitle("Terminal");
    await terminalTab.click();
    // Terminal panel is present (renders a black bg container)
    await expect(page.locator(".bg-black").first()).toBeVisible();
    // Chat composer is hidden
    await expect(composer).not.toBeVisible();

    // Navigate to Files tab
    const filesTab = page.getByTitle("Files");
    await filesTab.click();
    await expect(page.getByText("Files")).toBeVisible();
    await expect(composer).not.toBeVisible();

    // Navigate back to Chat tab
    const chatTab = page.getByTitle("Chat");
    await chatTab.click();
    await expect(composer).toBeVisible();
  });

  test("UF-17a slash command menu appears when typing /", async ({ page }) => {
    await setupApp(page);

    await page.getByPlaceholder("Message Claude…").type("/");

    // Command menu becomes visible
    await expect(page.getByText("/help")).toBeVisible();
    await expect(page.getByText("/clear")).toBeVisible();
  });

  test("UF-17b selecting a slash command fills the composer", async ({ page }) => {
    await setupApp(page);

    const composer = page.getByPlaceholder("Message Claude…");
    await composer.type("/");

    // Click the /clear command
    await page.getByRole("button", { name: /\/clear/ }).click();

    // Composer is filled with the command
    await expect(composer).toHaveValue("/clear ");

    // Menu closes after selection
    await expect(page.getByText("/help")).not.toBeVisible();
  });
});
