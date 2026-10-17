import { expect } from "@playwright/test";
export const owner = { email: "owner@example.com", password: "E2E-only-password-28" };
// Fails the test on any script error or console error after sign-in.
export function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 401/.test(m.text())) errors.push(m.text());
  });
  return errors;
}
export async function signIn(page) {
  await page.goto("/");
  await page.fill('form[data-form="login"] input[name=email]', owner.email);
  await page.fill('form[data-form="login"] input[name=password]', owner.password);
  await page.click('form[data-form="login"] button[type=submit]');
  await expect(page.locator(".sidebar")).toBeVisible();
}
export const unique = (prefix) => `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export async function createClient(page, name, email = "client@example.com") {
  await page.goto("/#/clients");
  await page.click('[data-action="new-client"]');
  const form = page.locator('form[data-form="client"]');
  await form.locator("input[name=name]").fill(name);
  await form.locator("input[name=email]").fill(email);
  await form.locator("input[name=contact]").fill("Aminah");
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Client saved");
}
