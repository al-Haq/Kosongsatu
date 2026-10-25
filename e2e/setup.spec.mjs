import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique } from "./helpers.mjs";

// Smallest valid PNG (1x1), as in test/helpers.mjs.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");
const workspace = (page) => page.evaluate(() => fetch("/api/workspace").then((r) => r.json()));
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function signOut(page) {
  await page.click(".avatar-menu summary");
  await page.click('[data-action="logout"]');
  await expect(page.locator('form[data-form="login"]')).toBeVisible();
  // No authenticator code box unless an account that uses one is signing in.
  await expect(page.locator('form[data-form="login"] input[name=code]')).toBeHidden();
  await expect(page.getByText("Use an authenticator")).toHaveCount(0);
}

test("setup checklist: progress, links to the place to fix each step, skip and hide kept on the server", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto("/#/overview");
  const panel = page.locator(".setup-panel");
  const count = panel.locator(".panel-head p");
  const step = (key) => panel.locator(`[data-setup-step="${key}"]`);
  await expect(panel).toBeVisible();
  await expect(count).toHaveText(/^\d of 8 done$/);
  const done = Number((await count.textContent()).split(" ")[0]);
  // The test workspace has bank details, clients and issued invoices, but no logo, email or backups.
  // Two-step sign-in is not offered for now (public/ext/features.mjs), so it is not a step.
  await expect(step("mfa")).toHaveCount(0);
  await expect(step("first")).toHaveClass(/done/);
  await expect(step("bank")).toHaveClass(/done/);
  for (const [key, href] of [
    ["logo", "#/settings"],
    ["mail", "#/settings/integrations"],
    ["gateway", "#/settings/payments"],
    ["backup", "#/settings/security"],
  ])
    await expect(step(key).locator("a.btn")).toHaveAttribute("href", href);

  // Each link opens the Settings tab with the field or section to fix in view.
  await step("company").locator("a.btn").click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.locator('form[data-form="settings"] input:focus')).toHaveCount(1);
  await page.goto("/#/overview");
  await step("logo").locator("a.btn").click();
  await expect(page.locator(".settings-tabs .tab.active")).toHaveText("Company");
  await expect(page.locator('form[data-form="doc-logo"] input[type=file]')).toBeFocused();
  // Nor is it offered under Settings > Security.
  await page.goto("/#/settings/security");
  await expect(page.locator("main section.panel h2", { hasText: "Authenticator and recovery" })).toHaveCount(0);

  // An optional step can be marked as not needed, and undone.
  await page.goto("/#/overview");
  await step("sst").locator('[data-action="setup-skip"]').click();
  await expect(page.locator("#toast")).toContainText("not registered for SST");
  await expect(count).toHaveText(`${done + 1} of 8 done`);
  await panel.locator(".setup-done summary").click();
  await expect(step("sst")).toContainText("Not registered");

  // Fits a phone screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(await noSidewaysScroll(page)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Hide: kept on the server, so a reload or another device does not bring it back.
  await panel.locator('[data-action="setup-dismiss"]').click();
  await expect(page.locator("#toast")).toContainText("Checklist hidden");
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(page.locator("main h1").first()).toHaveText("Overview");
  await expect(panel).toHaveCount(0);
  expect((await workspace(page)).settings.setup.dismissed).toBeTruthy();

  // It comes back from Settings > Modules. Then put the workspace back for the other tests.
  await page.goto("/#/settings/modules");
  await page.click('[data-action="setup-show"]');
  await expect(page.locator("#toast")).toContainText("back on the Overview");
  await page.goto("/#/overview");
  await expect(panel).toBeVisible();
  await panel.locator(".setup-done summary").click();
  await step("sst").locator('[data-action="setup-unskip"]').click();
  await expect(count).toHaveText(`${done} of 8 done`);
  expect(errors).toEqual([]);
});

test("modules: turning one off hides its menu entries, Overview panel and settings; turning it on brings them back", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const nav = (key) => page.locator(`.sidebar nav a[href="#/${key}"]`);
  const toggle = (key) => page.locator(`[data-setup-module="${key}"]`);
  await page.goto("/#/settings/modules");
  await expect(page.locator(".settings-tabs .tab.active")).toHaveText("Modules");
  // Everything is on to start with.
  await expect(page.locator("[data-setup-module]:not(:checked)")).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBeLessThanOrEqual(1);

  // A browser module's entries (Books) and a core entry (Proforma).
  await toggle("books").click();
  await expect(page.locator("#toast")).toContainText("Expenses, bills and reports is off");
  await expect(toggle("books")).not.toBeChecked();
  for (const key of ["expenses", "bills", "reports"]) await expect(nav(key)).toHaveCount(0);
  await toggle("proforma").click();
  await expect(toggle("proforma")).not.toBeChecked();
  await expect(nav("proformas")).toHaveCount(0);
  await expect(nav("invoices")).toBeVisible();
  await expect(nav("settings")).toBeVisible();

  // Its settings section and Overview panel go too, and nothing else.
  await page.goto("/#/settings");
  await expect(page.locator("main section.panel h2", { hasText: /^Company$/ })).toBeVisible();
  await expect(page.locator("main section.panel h2", { hasText: /^Books$/ })).toHaveCount(0);
  await page.goto("/#/overview");
  await expect(page.locator(".metrics").first()).toBeVisible();
  await expect(page.locator(".books-health")).toHaveCount(0);
  // The records and their pages still work.
  await page.goto("/#/expenses");
  await expect(page.locator("main h1").first()).toBeVisible();
  await expect(page.locator(".empty h2", { hasText: "Page not found" })).toHaveCount(0);
  // Kept on the server.
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(nav("expenses")).toHaveCount(0);
  expect((await workspace(page)).settings.modules).toEqual({ books: false, proforma: false });

  // Back on: everything returns.
  await page.goto("/#/settings/modules");
  await toggle("books").click();
  await expect(page.locator("#toast")).toContainText("is on again");
  await expect(nav("expenses")).toBeVisible();
  await toggle("proforma").click();
  await expect(toggle("proforma")).toBeChecked();
  await expect(nav("proformas")).toBeVisible();
  await page.goto("/#/settings");
  await expect(page.locator("main section.panel h2", { hasText: /^Books$/ })).toBeVisible();
  await page.goto("/#/overview");
  await expect(page.locator(".books-health")).toBeVisible();
  expect((await workspace(page)).settings.modules).toEqual({});
  expect(errors).toEqual([]);
});

test("branding: the business name and logo replace the Nawlogic brand in the sidebar and on the sign-in page", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  // The test workspace keeps the default name, so the Nawlogic brand shows.
  await expect(page.locator('.sidebar img.logo[src="/assets/nawlogic-logo.png"]')).toBeVisible();
  await expect(page.locator(".sidebar .owner-box strong")).toHaveText("Nawlogic");
  const company = page.locator('form[data-form="settings"] input[name=company]');

  // The company name.
  const name = unique("Kedai Aminah");
  await page.goto("/#/settings");
  await company.fill(name);
  await page.locator('form[data-form="settings"] button[type=submit]').click();
  await expect(page.locator("#toast")).toContainText("Workspace settings saved");
  await expect(page.locator(".sidebar .brand-name")).toHaveText(name);
  await expect(page.locator(".sidebar .owner-box strong")).toHaveText(name);
  await expect(page).toHaveTitle(`Settings · ${name}`);
  await signOut(page);
  await expect(page.locator(".login-inner .brand-name")).toHaveText(name);
  await expect(page.getByText(`Sign in to the ${name} workspace.`)).toBeVisible();
  await expect(page).toHaveTitle(`Sign in · ${name}`);

  // The logo from Settings > Company.
  await signIn(page);
  await page.goto("/#/settings");
  await page.locator('form[data-form="doc-logo"] input[type=file]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await page.locator('form[data-form="doc-logo"] button[type=submit]').click();
  await expect(page.locator("#toast")).toContainText("Logo saved");
  const sidebarLogo = page.locator(".sidebar img.brand-logo");
  await expect(sidebarLogo).toHaveAttribute("src", /^\/api\/files\/[\w-]+$/);
  await expect(sidebarLogo).toHaveAttribute("alt", name);

  // A first visit, signed out: the name and logo come from the public branding endpoint.
  await page.context().clearCookies();
  await page.goto("/");
  const loginLogo = page.locator(".login-inner img.brand-logo");
  await expect(loginLogo).toHaveAttribute("src", /^\/api\/guest\/setup\/logo\?v=[\w-]+$/);
  await expect.poll(() => loginLogo.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator(".login-brand .eyebrow")).toContainText(name);
  await expect(page).toHaveTitle(`Sign in · ${name}`);

  // Put the workspace back for the other tests: no logo and the default name.
  await signIn(page);
  await page.goto("/#/settings");
  await page.click('[data-action="doc-logo-remove"]');
  await expect(page.locator("#toast")).toContainText("Nawlogic logo again");
  await page.goto("/#/settings");
  await company.fill("NAWLOGIC SYSTEMS SOLUTION");
  await page.locator('form[data-form="settings"] button[type=submit]').click();
  await expect(page.locator(".sidebar .owner-box strong")).toHaveText("Nawlogic");
  await signOut(page);
  await expect(page.locator('.login-inner img.logo[src="/assets/nawlogic-logo.png"]')).toBeVisible();
  await expect(page).toHaveTitle("Nawlogic Invoice");
  expect(errors).toEqual([]);
});
