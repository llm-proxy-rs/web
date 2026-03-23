/**
 * Tests for assistant message copy button positioning.
 *
 * CP-01  Hovering the assistant card reveals a visible copy button
 * CP-02  Copy button is inside the card bounds (not clipped)
 * CP-03  Copy button copies the full turn text content
 * CP-04  Copy button shows "Copied!" title after clicking
 * CP-05  User message copy button is still visible on hover
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("assistant copy button", () => {
  test("CP-01 hovering the assistant card reveals a visible copy button", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Here is my response.", "sess-cp1"));

    await expect(page.getByText("Here is my response.")).toBeVisible();

    // Before hovering — copy button is not visible
    await expect(page.getByTitle("Copy", { exact: true })).not.toBeVisible();

    // Hover over the assistant card
    const card = page.locator('[data-testid="assistant-card"]').first();
    await card.hover();

    // Copy button should be visible
    await expect(page.getByTitle("Copy", { exact: true })).toBeVisible();
  });

  test("CP-02 copy button is inside the card bounds", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Test response.", "sess-cp2"));

    const card = page.locator('[data-testid="assistant-card"]').first();
    await expect(card).toBeVisible();
    await card.hover();

    const copyBtn = page.getByTitle("Copy", { exact: true });
    await expect(copyBtn).toBeVisible();

    // Get bounding boxes
    const cardBox = await card.boundingBox();
    const btnBox = await copyBtn.boundingBox();

    // Button should be within the card's horizontal and vertical bounds
    expect(btnBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
    expect(btnBox!.x + btnBox!.width).toBeLessThanOrEqual(
      cardBox!.x + cardBox!.width,
    );
    expect(btnBox!.y).toBeGreaterThanOrEqual(cardBox!.y);
    expect(btnBox!.y + btnBox!.height).toBeLessThanOrEqual(
      cardBox!.y + cardBox!.height,
    );
  });

  test("CP-03 copy button copies the assistant text content", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Copyable response text.", "sess-cp3"));

    const card = page.locator('[data-testid="assistant-card"]').first();
    await expect(card).toBeVisible();
    await card.hover();

    const copyBtn = page.getByTitle("Copy", { exact: true });
    await expect(copyBtn).toBeVisible();

    // Grant clipboard permission and click
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await copyBtn.click();

    // Read clipboard
    const clipboardText = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboardText).toContain("Copyable response text.");
  });

  test("CP-04 copy button shows Copied title after clicking", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Some text.", "sess-cp4"));

    const card = page.locator('[data-testid="assistant-card"]').first();
    await card.hover();

    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);

    const copyBtn = page.getByTitle("Copy", { exact: true });
    await copyBtn.click();

    // After clicking, the button title should change to "Copied!"
    await expect(page.getByTitle("Copied!")).toBeVisible();
  });

  test("CP-05 user message copy button is still visible on hover", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "My user message");
    ctrl.sendSseEvents(sse.text("Reply.", "sess-cp5"));

    // Hover the user message bubble (the primary-colored bubble, not the sidebar)
    const userBubble = page
      .locator(".bg-primary")
      .filter({ hasText: "My user message" })
      .first();
    await userBubble.hover();

    // User message copy button should appear
    await expect(page.getByTitle("Copy", { exact: true })).toBeVisible();
  });
});
