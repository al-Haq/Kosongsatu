import { test, expect } from "@playwright/test";
import { signIn, watchErrors } from "./helpers.mjs";

test("every workspace page opens without errors", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const links = await page.locator(".sidebar nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(links.length).toBeGreaterThan(8);
  for (const href of links) {
    await page.goto("/" + href);
    await expect(page.locator("main h1").first(), href).toBeVisible();
    await expect(page.locator(".empty h2", { hasText: "Page not found" })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test("wrong password is refused and the owner can sign out", async ({ page }) => {
  await page.goto("/");
  await page.fill('form[data-form="login"] input[name=email]', "owner@example.com");
  await page.fill('form[data-form="login"] input[name=password]', "not-the-password-123");
  await page.click('form[data-form="login"] button[type=submit]');
  await expect(page.locator('form[data-form="login"] .form-error')).toContainText("incorrect");
  await signIn(page);
  await page.click(".avatar-menu summary");
  await page.click('[data-action="logout"]');
  await expect(page.locator('form[data-form="login"]')).toBeVisible();
});
