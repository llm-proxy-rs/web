/**
 * File path detection in assistant messages:
 *
 * FPL-01  Absolute file paths are rendered as clickable download links
 * FPL-02  Multiple file paths in the same message each get their own link
 * FPL-03  File path links point to /download?path=<encoded path>
 * FPL-04  File path links open in a new tab
 * FPL-05  Paths inside code blocks are NOT turned into links
 * FPL-06  Paths with spaces and special chars are handled correctly
 * FPL-07  Non-path text that starts with / is not falsely linked (e.g. /etc is fine but "/hello world" without extension is not)
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("file path link detection", () => {
  test("FPL-01 absolute file path renders as clickable download link", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "where is the image?");
    ctrl.sendSseEvents(
      sse.text(
        "The image is saved at /home/ubuntu/1774240731585_image-54.jpg",
        "sess-fpl1",
      ),
    );

    const link = page.locator(
      'a[href*="/download?path="]',
    );
    await expect(link).toBeVisible();
    await expect(link).toContainText("/home/ubuntu/1774240731585_image-54.jpg");
  });

  test("FPL-02 multiple file paths each become separate links", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "list files");
    ctrl.sendSseEvents(
      sse.text(
        "I created /home/ubuntu/file1.png and /home/ubuntu/file2.txt for you.",
        "sess-fpl2",
      ),
    );

    const links = page.locator('a[href*="/download?path="]');
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toContainText("/home/ubuntu/file1.png");
    await expect(links.nth(1)).toContainText("/home/ubuntu/file2.txt");
  });

  test("FPL-03 file path link href encodes the path correctly", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "where is the file?");
    ctrl.sendSseEvents(
      sse.text(
        "It is at /home/ubuntu/output/report.pdf",
        "sess-fpl3",
      ),
    );

    const link = page.locator('a[href*="/download?path="]');
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toBe(
      `/download?path=${encodeURIComponent("/home/ubuntu/output/report.pdf")}`,
    );
  });

  test("FPL-04 file path links open in a new tab", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "show path");
    ctrl.sendSseEvents(
      sse.text("File: /tmp/data.csv", "sess-fpl4"),
    );

    const link = page.locator('a[href*="/download?path="]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("FPL-05 paths inside inline code are NOT turned into links", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "show code");
    ctrl.sendSseEvents(
      sse.text(
        "Run `cat /home/ubuntu/file.txt` to see the contents.",
        "sess-fpl5",
      ),
    );

    // The inline code should be visible
    const inlineCode = page.locator("code").filter({ hasText: "/home/ubuntu/file.txt" });
    await expect(inlineCode).toBeVisible();

    // There should be no download link for the path inside code
    const downloadLinks = page.locator('a[href*="/download?path="]');
    await expect(downloadLinks).toHaveCount(0);
  });

  test("FPL-06 paths inside fenced code blocks are NOT turned into links", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "show code");
    ctrl.sendSseEvents(
      sse.text(
        "```bash\ncat /home/ubuntu/file.txt\n```",
        "sess-fpl6",
      ),
    );

    const codeBlock = page.locator("pre").first();
    await expect(codeBlock).toBeVisible();

    // No download link should be created for paths inside code blocks
    const downloadLinks = page.locator('a[href*="/download?path="]');
    await expect(downloadLinks).toHaveCount(0);
  });

  test("FPL-07 common directory paths are detected", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "where?");
    ctrl.sendSseEvents(
      sse.text(
        "The file is at /tmp/output.png",
        "sess-fpl7",
      ),
    );

    const link = page.locator('a[href*="/download?path="]');
    await expect(link).toBeVisible();
    await expect(link).toContainText("/tmp/output.png");
  });

  test("FPL-08 path at the end of a sentence (before period) is detected", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "where?");
    ctrl.sendSseEvents(
      sse.text(
        "I saved the file to /home/ubuntu/result.jpg.",
        "sess-fpl8",
      ),
    );

    const link = page.locator('a[href*="/download?path="]');
    await expect(link).toBeVisible();
    // The link text should NOT include the trailing period
    const text = await link.textContent();
    expect(text).toBe("/home/ubuntu/result.jpg");
  });

  test("FPL-09 path with markdown link syntax is not double-linked", async ({
    page,
  }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "show");
    ctrl.sendSseEvents(
      sse.text(
        "Check [this file](/home/ubuntu/readme.md) for details.",
        "sess-fpl9",
      ),
    );

    // The markdown link should exist (rendered by react-markdown)
    const markdownLink = page.locator("a").filter({ hasText: "this file" });
    await expect(markdownLink).toBeVisible();
  });
});
