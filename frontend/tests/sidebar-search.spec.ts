/**
 * SS-01  Search filters conversations by title
 * SS-02  Clearing search restores full list
 * SS-03  Search with no matches shows empty state
 * SS-04  Search is case-insensitive
 */
import { test, expect } from "@playwright/test";
import { setupApp, makeConversation } from "./helpers/setup";

test.describe("sidebar search", () => {
  test("SS-01 search input filters conversations by title", async ({
    page,
  }) => {
    await setupApp(page, {
      conversations: [
        makeConversation({ title: "React hooks guide" }),
        makeConversation({ title: "Python basics" }),
        makeConversation({ title: "React components" }),
      ],
    });

    const searchInput = page.getByPlaceholder("Search conversations…");
    await searchInput.fill("React");

    await expect(
      page.locator("span.truncate").filter({ hasText: "React hooks guide" }),
    ).toBeVisible();
    await expect(
      page.locator("span.truncate").filter({ hasText: "React components" }),
    ).toBeVisible();
    await expect(
      page.locator("span.truncate").filter({ hasText: "Python basics" }),
    ).not.toBeVisible();
  });

  test("SS-02 clearing search restores full list", async ({ page }) => {
    await setupApp(page, {
      conversations: [
        makeConversation({ title: "React hooks guide" }),
        makeConversation({ title: "Python basics" }),
      ],
    });

    const searchInput = page.getByPlaceholder("Search conversations…");
    await searchInput.fill("React");

    // Only React visible
    await expect(
      page.locator("span.truncate").filter({ hasText: "Python basics" }),
    ).not.toBeVisible();

    // Clear search
    await searchInput.fill("");

    await expect(
      page.locator("span.truncate").filter({ hasText: "React hooks guide" }),
    ).toBeVisible();
    await expect(
      page.locator("span.truncate").filter({ hasText: "Python basics" }),
    ).toBeVisible();
  });

  test("SS-03 search with no matches shows empty state", async ({ page }) => {
    await setupApp(page, {
      conversations: [makeConversation({ title: "React hooks guide" })],
    });

    const searchInput = page.getByPlaceholder("Search conversations…");
    await searchInput.fill("nonexistent");

    await expect(page.getByText("No conversations yet")).toBeVisible();
  });

  test("SS-04 search is case-insensitive", async ({ page }) => {
    await setupApp(page, {
      conversations: [makeConversation({ title: "Hello World" })],
    });

    const searchInput = page.getByPlaceholder("Search conversations…");
    await searchInput.fill("hello");

    await expect(
      page.locator("span.truncate").filter({ hasText: "Hello World" }),
    ).toBeVisible();
  });
});
