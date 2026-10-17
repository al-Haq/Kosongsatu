import { test, expect } from "@playwright/test";
import { signIn, watchErrors } from "./helpers.mjs";

test("phone layout: navigation drawer and no sideways scrolling", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  for (const route of ["overview", "invoices", "clients", "settings"]) {
    await page.goto("/#/" + route);
    await expect(page.locator("main h1").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, route).toBeLessThanOrEqual(1);
  }
  await page.click('[data-action="toggle-nav"]');
  await expect(page.locator(".sidebar.open")).toBeVisible();
  await page.locator('.sidebar nav a[href="#/payments"]').click();
  await expect(page.locator("main h1").first()).toHaveText("Payments");
  expect(errors).toEqual([]);
});
