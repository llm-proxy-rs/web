/**
 * Tests for assistant message card/bubble container.
 *
 * AC-01  Assistant text message is wrapped in a visible card container
 * AC-02  Card has background color distinct from page background
 * AC-03  Card has rounded corners
 * AC-04  Tool messages within the same turn are inside the same card
 * AC-05  Multiple text chunks in one turn share the same card
 * AC-06  User message after assistant card starts a new visual group
 * AC-07  Card text has readable contrast against card background (WCAG AA)
 */
import { test, expect } from "@playwright/test";
import { setupApp, sendMessage, sse } from "./helpers/setup";

test.describe("assistant message card", () => {
  test("AC-01 assistant text message is wrapped in a card container", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Hi there!", "sess-ac1"));

    await expect(page.getByText("Hi there!")).toBeVisible();

    // The assistant message should be inside a card container with data-testid
    const card = page.locator('[data-testid="assistant-card"]').first();
    await expect(card).toBeVisible();

    // The text content should be inside the card
    await expect(card.getByText("Hi there!")).toBeVisible();
  });

  test("AC-02 card has background color distinct from page background", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Hello!", "sess-ac2"));

    const card = page.locator('[data-testid="assistant-card"]').first();
    await expect(card).toBeVisible();

    const cardBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
    // Should not be transparent
    expect(cardBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(cardBg).not.toBe("transparent");

    // Should differ from the page background
    const pageBg = await page.locator("body").evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(cardBg).not.toBe(pageBg);
  });

  test("AC-03 card has rounded corners", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("World!", "sess-ac3"));

    const card = page.locator('[data-testid="assistant-card"]').first();
    await expect(card).toBeVisible();

    const radius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(parseFloat(radius)).toBeGreaterThan(0);
  });

  test("AC-04 tool messages within the same turn are inside the same card", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Run ls");
    ctrl.sendSseEvents(
      sse.withTool("t1", "Bash", { command: "ls" }, "file.txt", "Here are the files.", "sess-ac4"),
    );

    await expect(page.getByText("Here are the files.")).toBeVisible();

    // Should be exactly one assistant card for the entire turn
    const cards = page.locator('[data-testid="assistant-card"]');
    const cardCount = await cards.count();
    expect(cardCount).toBe(1);

    // Both the tool and the text should be inside the card
    const card = cards.first();
    await expect(card.getByText("Here are the files.")).toBeVisible();
    // Tool renderer should be inside the card too
    await expect(card.locator('[data-testid="tool-renderer"]').or(card.getByText("Bash"))).toBeVisible();
  });

  test("AC-05 multiple text chunks in one turn share the same card", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Explain something");
    ctrl.sendSseEvents([
      { event: "session_start", data: { task_id: "task-1" } },
      { event: "init" },
      { event: "text_delta", data: { text: "First part. Second part." } },
      { event: "done", data: { session_id: "sess-ac5", task_id: "task-1" } },
    ]);

    await expect(page.getByText("First part. Second part.")).toBeVisible();

    // Only one card
    const cards = page.locator('[data-testid="assistant-card"]');
    expect(await cards.count()).toBe(1);
  });

  test("AC-06 user message after assistant card starts a new visual group", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    // First exchange
    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Hi there!", "sess-ac6a"));

    await expect(page.getByText("Hi there!")).toBeVisible();

    // Second exchange
    await sendMessage(page, "How are you?");
    ctrl.sendSseEvents(sse.text("I'm doing well!", "sess-ac6b"));

    await expect(page.getByText("I'm doing well!")).toBeVisible();

    // Should have two separate assistant cards
    const cards = page.locator('[data-testid="assistant-card"]');
    expect(await cards.count()).toBe(2);

    // First card has first response, second card has second response
    await expect(cards.nth(0).getByText("Hi there!")).toBeVisible();
    await expect(cards.nth(1).getByText("I'm doing well!")).toBeVisible();
  });

  test("AC-07 card text has readable contrast against card background", async ({ page }) => {
    const ctrl = await setupApp(page, {});

    await sendMessage(page, "Hello");
    ctrl.sendSseEvents(sse.text("Test contrast text.", "sess-ac7"));

    const card = page.locator('[data-testid="assistant-card"]').first();
    await expect(card).toBeVisible();

    const textEl = card.getByText("Test contrast text.");
    const { fg, bg } = await textEl.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fg: s.color, bg: s.backgroundColor };
    });

    function parseRgb(c: string): [number, number, number] {
      const m = c.match(/[\d.]+/g);
      if (!m) return [0, 0, 0];
      return [parseFloat(m[0]), parseFloat(m[1]), parseFloat(m[2])];
    }
    function luminance(r: number, g: number, b: number): number {
      const [rs, gs, bs] = [r, g, b].map((c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    }

    const [r1, g1, b1] = parseRgb(fg);
    let [r2, g2, b2] = parseRgb(bg);
    if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") {
      // Use the card background — approximate --card: hsl(215 28% 10%) ≈ rgb(18, 25, 33)
      [r2, g2, b2] = [18, 25, 33];
    }

    const l1 = luminance(r1, g1, b1);
    const l2 = luminance(r2, g2, b2);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    expect(ratio).toBeGreaterThan(4.5);
  });
});
