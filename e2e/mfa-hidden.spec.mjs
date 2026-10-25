import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique } from "./helpers.mjs";
import { totp } from "../server/mfa.mjs";

// Two-step sign-in is not offered for now (public/ext/features.mjs), but an
// account that already uses it keeps it: the code box appears after its
// password, and it can still manage MFA from My account.
test("MFA hidden: no code box for most people; an account that uses MFA is asked after its password", async ({ page, context }) => {
  test.setTimeout(60000);
  const errors = watchErrors(page);
  await signIn(page);
  const email = `${unique("mfa").replace(/\s+/g, "-").toLowerCase()}@example.com`;
  const password = "E2E-mfa-password-28";
  await page.goto("/#/team");
  await page.click('[data-action="team-invite"]');
  const invite = page.locator('form[data-form="team-invite"]');
  await invite.locator("input[name=email]").fill(email);
  await invite.locator("select[name=role]").selectOption("staff");
  await invite.locator("button[type=submit]").click();
  const link = await page.locator("input[name=teamlink]").inputValue();
  await page.keyboard.press("Escape");

  const other = await context.browser().newContext();
  const staff = await other.newPage();
  await staff.goto(link);
  const join = staff.locator('form[data-form="team-guest"]');
  await join.locator("input[name=password]").fill(password);
  await join.locator("input[name=confirm]").fill(password);
  await join.locator("button[type=submit]").click();
  await expect(staff.locator(".login-inner")).toContainText("Your account is ready");

  // Signing in: email and password only.
  const login = staff.locator('form[data-form="login"]');
  await staff.goto(new URL("/", page.url()).href);
  await expect(login.locator("input[name=code]")).toBeHidden();
  await login.locator("input[name=email]").fill(email);
  await login.locator("input[name=password]").fill(password);
  await login.locator("button[type=submit]").click();
  await expect(staff.locator(".sidebar")).toBeVisible();
  await staff.goto(new URL("/#/account", page.url()).href);
  await expect(staff.locator("main h2", { hasText: "Authenticator and recovery" })).toHaveCount(0);

  // This account turned MFA on earlier (through the API, as the screen no longer offers it).
  const secret = await staff.evaluate(
    async ({ password }) => {
      const { csrf } = await (await fetch("/api/session")).json();
      const post = (path, body) =>
        fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) }).then((r) =>
          r.json(),
        );
      return (await post("/api/mfa/begin", { password })).secret;
    },
    { password },
  );
  const enabled = await staff.evaluate(
    async ({ password, code }) => {
      const { csrf } = await (await fetch("/api/session")).json();
      const r = await fetch("/api/mfa/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ password, code }),
      });
      return r.json();
    },
    { password, code: totp(secret) },
  );
  expect(enabled.codes?.length).toBeGreaterThan(0);

  // It can still manage MFA from My account.
  await staff.goto(new URL("/#/account", page.url()).href);
  await staff.reload();
  await expect(staff.locator("main h2", { hasText: "Authenticator and recovery" })).toBeVisible();

  // Signing in again: the code box appears only after the password.
  await other.clearCookies();
  await staff.goto(new URL("/", page.url()).href);
  await expect(login.locator("input[name=code]")).toBeHidden();
  await login.locator("input[name=email]").fill(email);
  await login.locator("input[name=password]").fill(password);
  await login.locator("button[type=submit]").click();
  await expect(login.locator("input[name=code]")).toBeVisible();
  await expect(login.locator("input[name=code]")).toBeFocused();
  await login.locator("input[name=code]").fill(enabled.codes[0]);
  await login.locator("button[type=submit]").click();
  await expect(staff.locator(".sidebar")).toBeVisible();

  await other.close();
  expect(errors).toEqual([]);
});
