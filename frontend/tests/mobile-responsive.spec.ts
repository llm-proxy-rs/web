/**
 * MR-01  On narrow viewport, sidebar is hidden by default
 * MR-02  Bottom navigation bar visible on mobile
 * MR-03  Tapping Chat/Terminal in bottom nav switches views
 * MR-04  On wide viewport, sidebar visible and bottom nav hidden
 */
import { test, expect } from "@playwright/test";
import { setupApp, makeConversation } from "./helpers/setup";

test.describe("mobile responsive", () => {
  test("MR-01 on narrow viewport, sidebar is hidden by default", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await setupApp(page, {});

    // Sidebar header should not be visible
    await expect(page.getByText("Conversations", { exact: true })).not.toBeVisible();
  });

  test("MR-02 bottom navigation bar visible on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await setupApp(page, {});

    const mobileNav = page.locator("[data-testid='mobile-nav']");
    await expect(mobileNav).toBeVisible();
    await expect(mobileNav.getByText("Chat")).toBeVisible();
    await expect(mobileNav.getByText("History")).toBeVisible();
    await expect(mobileNav.getByText("Terminal")).toBeVisible();
  });

  test("MR-03 tapping Chat/Terminal in bottom nav switches views", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await setupApp(page, {});

    // Should start on Chat view
    await expect(page.getByText("Welcome back")).toBeVisible();

    // Tap Terminal
    const mobileNav = page.locator("[data-testid='mobile-nav']");
    await mobileNav.getByText("Terminal").click();

    // Chat blank state gone, terminal visible (xterm container)
    await expect(page.getByText("Welcome back")).not.toBeVisible();

    // Tap Chat
    await mobileNav.getByText("Chat").click();
    await expect(page.getByText("Welcome back")).toBeVisible();
  });

  test("MR-04 on wide viewport, sidebar visible and bottom nav hidden", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupApp(page, {});

    // Sidebar visible
    await expect(page.getByText("Conversations", { exact: true })).toBeVisible();
    // Bottom nav not visible
    await expect(page.locator("[data-testid='mobile-nav']")).not.toBeVisible();
  });

  test("MR-05 tapping History opens sidebar overlay showing conversations", async ({ page }) => {
    const conv = makeConversation({ title: "Test conversation" });
    await page.setViewportSize({ width: 375, height: 667 });
    await setupApp(page, { conversations: [conv] });

    // Sidebar should be hidden initially
    await expect(page.getByText("Conversations", { exact: true })).not.toBeVisible();

    // Tap History button
    const mobileNav = page.locator("[data-testid='mobile-nav']");
    await mobileNav.getByText("History").click();

    // Sidebar overlay should now be visible with the conversation
    await expect(page.getByText("Conversations", { exact: true })).toBeVisible();
    await expect(page.getByText("Test conversation")).toBeVisible();
  });

  test("MR-06 selecting a conversation in mobile sidebar closes it", async ({ page }) => {
    const conv = makeConversation({ title: "Pick me" });
    await page.setViewportSize({ width: 375, height: 667 });
    await setupApp(page, { conversations: [conv] });

    // Open sidebar
    const mobileNav = page.locator("[data-testid='mobile-nav']");
    await mobileNav.getByText("History").click();
    await expect(page.getByText("Pick me")).toBeVisible();

    // Select the conversation
    await page.getByText("Pick me").click();

    // Sidebar should close
    await expect(page.getByText("Conversations", { exact: true })).not.toBeVisible();
  });
});
