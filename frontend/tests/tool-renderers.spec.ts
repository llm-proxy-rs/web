/**
 * Specialized tool renderers:
 * - Grep tool shows pattern
 * - WebFetch tool shows URL
 * - WebSearch tool shows query
 * - Tool result Show more/Show less toggle
 * - Write tool shows "New" badge
 * - ApplyPatch tool shows "Patch" badge
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("tool renderers", () => {
  test("Grep tool shows the search pattern", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Search for errors");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-grep",
        "Grep",
        { pattern: "ERROR.*fatal", path: "/var/log" },
        "error.log:42:ERROR fatal crash",
        "Found errors.",
        "sess-grep",
      ),
    );

    // Tool summary shows the pattern
    await expect(page.getByText("Grep")).toBeVisible();
    await expect(page.getByText("/ERROR.*fatal/")).toBeVisible();

    // Expand to see the detailed input
    await page.getByRole("button", { name: /Grep/ }).click();
    await expect(page.getByText("/var/log")).toBeVisible();
  });

  test("WebFetch tool shows the URL", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Fetch this page");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-fetch",
        "WebFetch",
        { url: "https://example.com/api/docs" },
        "Page content here",
        "Fetched successfully.",
        "sess-fetch",
      ),
    );

    await expect(page.getByText("WebFetch")).toBeVisible();
    // Summary shows the URL
    await expect(page.getByText("https://example.com/api/docs")).toBeVisible();
  });

  test("WebSearch tool shows the query", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Search the web");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-search",
        "WebSearch",
        { query: "playwright testing best practices" },
        "Results: ...",
        "Here are the results.",
        "sess-search",
      ),
    );

    await expect(page.getByText("WebSearch")).toBeVisible();
    // Summary shows the query
    await expect(page.getByText("playwright testing best practices")).toBeVisible();
  });

  test("tool result Show more/Show less toggle works for long results", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    // Create a long result (>200 chars to trigger the toggle)
    const longResult = "line of output\n".repeat(30);

    await sendMessage(page, "Run something");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-long",
        "Bash",
        { command: "cat bigfile.txt" },
        longResult,
        "Done.",
        "sess-long",
      ),
    );

    await expect(page.getByText("Bash")).toBeVisible();

    // Expand the tool card
    await page.getByRole("button", { name: /Bash/ }).click();

    // "Show more" button should be visible for long results
    await expect(page.getByText("Show more")).toBeVisible();

    // Click "Show more"
    await page.getByText("Show more").click();

    // Now "Show less" should be visible
    await expect(page.getByText("Show less")).toBeVisible();

    // Click "Show less" to collapse
    await page.getByText("Show less").click();
    await expect(page.getByText("Show more")).toBeVisible();
  });

  test("Write tool shows New badge in diff viewer", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Create a file");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-write",
        "Write",
        { file_path: "/tmp/new-file.ts", content: "console.log('hello');" },
        "File written.",
        "Created the file.",
        "sess-write",
      ),
    );

    await expect(page.getByText("Write")).toBeVisible();

    // The diff viewer should show "New" badge
    await expect(page.getByText("New", { exact: true })).toBeVisible();
    // File path visible (use .first() since path appears in both tool header and diff viewer)
    await expect(page.getByText("/tmp/new-file.ts").first()).toBeVisible();
  });

  test("ApplyPatch tool shows Patch badge in diff viewer", async ({ page }) => {
    const ctrl = await setupApp(page, { sessions: [] });

    await sendMessage(page, "Patch a file");
    ctrl.sendSseEvents(
      sse.withTool(
        "tool-patch",
        "ApplyPatch",
        {
          file_path: "/tmp/existing.ts",
          old: "const x = 1;",
          new: "const x = 2;",
        },
        "Patch applied.",
        "Patched the file.",
        "sess-patch",
      ),
    );

    await expect(page.getByText("ApplyPatch")).toBeVisible();

    // The diff viewer should show "Patch" badge
    await expect(page.getByText("Patch", { exact: true })).toBeVisible();
    // File path visible
    await expect(page.getByText("/tmp/existing.ts")).toBeVisible();
  });
});
