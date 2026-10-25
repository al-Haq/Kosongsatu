import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique, owner } from "./helpers.mjs";

// Failed requests show up in the console; these tests cause them on purpose.
const real = (errors) =>
  errors.filter((e) => !/status of (401|403|409)/.test(e));

test("clients: a company or an individual, with labels that follow the choice", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto("/#/clients");
  await page.click('[data-action="new-client"]');
  const form = page.locator('form[data-form="client"]');
  // A company by default.
  await expect(form.locator("input[name=kind][value=company]")).toBeChecked();
  await expect(form.getByText("Company name")).toBeVisible();
  await expect(form.locator("input[name=contact]")).toBeVisible();
  await expect(form.getByText("Registration number (SSM)")).toBeVisible();

  await form.getByText("Individual", { exact: true }).click();
  await expect(form.getByText("Full name")).toBeVisible();
  await expect(form.getByText("Company name")).toBeHidden();
  await expect(form.locator("input[name=contact]")).toBeHidden();
  await expect(form.locator("input[name=sst_number]")).toBeHidden();
  await expect(form.getByText("IC or passport number")).toBeVisible();

  const name = unique("Aminah binti Ali");
  await form.locator("input[name=name]").fill(name);
  await form.locator("input[name=phone]").fill("012-345 6789");
  await form.locator("input[name=brn]").fill("900101-14-5678");
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Client saved");

  const row = page.locator("tr", { hasText: name });
  await expect(row.locator(".kind-tag")).toHaveText("Individual");
  await expect(row.locator('[data-label="Contact"]')).toHaveText(
    "012-345 6789",
  );

  await row.click();
  const details = page.locator("dl.detail");
  await expect(details).toContainText("Individual");
  await expect(details).not.toContainText("Billing contact");
  await expect(details).toContainText("IC or passport / TIN");
  await expect(details).toContainText("900101-14-5678");

  // Editing opens on the individual's labels.
  await page.click('[data-action="edit-client"]');
  await expect(
    form.locator("input[name=kind][value=individual]"),
  ).toBeChecked();
  await expect(form.getByText("Full name")).toBeVisible();
  expect(real(errors)).toEqual([]);
});

test("errors: an out-of-date sign-in check fixes itself for the same account, else says why and what to do", async ({
  page,
  context,
}) => {
  const errors = watchErrors(page);
  await signIn(page);

  // Signing in again in another tab replaces this page's sign-in check.
  const other = await context.newPage();
  await other.goto("/");
  const again = await other.evaluate(
    async ({ email, password }) =>
      (
        await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        })
      ).status,
    owner,
  );
  expect(again).toBe(200);
  await other.close();

  // This page still saves: it takes the new check and tries once more.
  await page.goto("/#/clients");
  await page.click('[data-action="new-client"]');
  const form = page.locator('form[data-form="client"]');
  await form.locator("input[name=name]").fill(unique("Retry Sdn Bhd"));
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Client saved");

  // When it keeps failing, the form says why and what to try.
  await page.route("**/api/clients", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Session verification failed. Refresh and try again.",
          }),
        })
      : route.continue(),
  );
  await page.click('[data-action="new-client"]');
  await form.locator("input[name=name]").fill(unique("Blocked Sdn Bhd"));
  await form.locator("button[type=submit]").click();
  const alert = form.getByRole("alert");
  await expect(alert.locator("strong")).toHaveText(
    "Session verification failed. Refresh and try again.",
  );
  await expect(alert.locator(".error-tip")).toContainText("reload the page");

  // Another account signed in meanwhile: no retry as them.
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ email: "someone.else@example.com", csrf: "x" }),
    }),
  );
  await form.locator("button[type=submit]").click();
  await expect(alert.locator("strong")).toHaveText(
    "You are now signed in as someone.else@example.com in another tab.",
  );
  await expect(alert.locator(".error-tip")).toContainText("Reload the page");
  await page.unroute("**/api/session");
  await page.unroute("**/api/clients");
  await page.keyboard.press("Escape");

  // The sign-in ended (signed out elsewhere): the sign-in page, with a tip.
  await context.clearCookies();
  await page.click('[data-action="new-client"]');
  await form.locator("input[name=name]").fill(unique("Later Sdn Bhd"));
  await form.locator("button[type=submit]").click();
  await expect(page.locator('form[data-form="login"]')).toBeVisible();
  await expect(page.locator("#toast")).toContainText("Please sign in.");
  await expect(page.locator("#toast .error-tip")).toContainText(
    "Sign in again",
  );
  expect(real(errors)).toEqual([]);
});
