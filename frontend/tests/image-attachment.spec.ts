/**
 * IA-01  Attach button exists in composer (single unified button)
 * IA-02  Selecting an image shows preview chip
 * IA-03  Removing an image chip removes it from pending list
 * IA-04  Images uploaded before message sent
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage } from "./helpers/setup";

test.describe("image attachment", () => {
  test("IA-01 attach button exists in composer", async ({ page }) => {
    await setupApp(page, {});

    await expect(page.getByTitle("Attach file")).toBeVisible();
    // No separate image button
    await expect(page.locator('button[title="Attach image"]')).toHaveCount(0);
  });

  test("IA-02 selecting an image shows preview chip", async ({ page }) => {
    await setupApp(page, {});

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from("fake-image-data"),
    });

    await expect(page.getByText("photo.png")).toBeVisible();
  });

  test("IA-03 removing an image chip removes it from pending list", async ({ page }) => {
    await setupApp(page, {});

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from("fake-image-data"),
    });

    await expect(page.getByText("photo.png")).toBeVisible();

    // Click the X button on the chip
    const chip = page.locator("span").filter({ hasText: "photo.png" });
    await chip.locator("button").click();

    await expect(page.getByText("photo.png")).not.toBeVisible();
  });

  test("IA-04 images uploaded before message sent", async ({ page }) => {
    let uploadReceived = false;

    const ctrl = await setupApp(page, {});

    // Override the upload route after setupApp (later routes have higher priority in Playwright)
    await page.route("**/chat-upload", async (route) => {
      uploadReceived = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ path: "/tmp/photo.png" }),
      });
    });

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from("fake-image-data"),
    });

    await sendMessage(page, "Check this image");

    // Let the upload + chat complete
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "t1" } },
      { event: "init" },
      { event: "text_delta", data: { text: "Got it" } },
      { event: "done", data: { session_id: "s1", task_id: "t1" } },
    ]);

    await expect(page.getByText("Got it")).toBeVisible();
    expect(uploadReceived).toBe(true);
    // The chat body should include the upload path reference
    const chatBody = ctrl.lastChatBody();
    expect(chatBody?.content).toContain("photo.png");
  });
});
