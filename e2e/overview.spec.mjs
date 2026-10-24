import { test, expect } from "@playwright/test";
import { signIn, watchErrors } from "./helpers.mjs";

test("overview: month comparisons, 12-week collections and aging; the menu marks the current page", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto("/#/overview");
  // The first row of cards (other modules add their own further down).
  const cards = page.locator(".metrics").first();
  await expect(cards.locator(".metric")).toHaveCount(4);
  await expect(cards.locator("svg.spark")).toHaveCount(2);
  await expect(cards.locator("svg.mini-aging")).toHaveCount(1);
  await expect(page.locator("svg.trend")).toBeVisible();
  // One tooltip target per week.
  await expect(page.locator("svg.trend rect.hit")).toHaveCount(12);
  await expect(page.locator(".trend-axis")).toContainText("Today");
  await expect(page.locator(".aging-panel h2")).toHaveText("Aging");
  // The current page in the left menu is a black pill with white text.
  const active = page.locator('.sidebar nav a[aria-current="page"]');
  await expect(active).toHaveText("Overview");
  expect(await active.evaluate((a) => [getComputedStyle(a).backgroundColor, getComputedStyle(a).color])).toEqual(["rgb(0, 0, 0)", "rgb(255, 255, 255)"]);
  await page.goto("/#/invoices");
  await expect(page.locator('.sidebar nav a[aria-current="page"]')).toHaveText("Invoices");
  expect(errors).toEqual([]);
});
