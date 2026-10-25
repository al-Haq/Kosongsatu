import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique, createClient } from "./helpers.mjs";

// Buttons the server would refuse for a role are not shown to that role.
test("staff and accountants do not see Reverse on a recorded payment, nor the activity", async ({
  page,
  context,
}) => {
  const errors = watchErrors(page);
  await signIn(page);
  const client = unique("E2E Roles Client");
  await createClient(page, client);

  // The owner issues an invoice and records a payment on it.
  await page.goto("/#/invoices");
  await page.click('[data-action="new-invoice"]');
  const editor = page.locator('form[data-form="editor"]');
  await editor
    .locator("select[name=client_id]")
    .selectOption({ label: client });
  await editor.locator(".item-description").first().fill("Network audit");
  await editor.locator(".item-rate").first().fill("400");
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");
  await page.click('[data-action="issue-document"]');
  await page.click('[data-action="confirm-issue"]');
  await expect(page.locator("#toast")).toContainText("Document issued");
  await page.click('[data-action="record-payment"]');
  const pay = page.locator('form[data-form="payment"]');
  await pay.locator("input[name=reference]").fill("E2E-ROLES-1");
  await pay.locator("input[name=confirmed]").check();
  await pay.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Payment confirmed");
  const docUrl = page.url();
  const history = (p) => p.locator(".payment", { hasText: "E2E-ROLES-1" });
  await expect(
    history(page).locator('[data-action="reverse-payment"]'),
  ).toBeVisible();
  // The owner sees the document's activity (who changed what).
  await expect(page.locator(".activity-panel")).toBeVisible();

  // Invite a staff member and let them set a password.
  const email = `staff-${Date.now().toString(36)}@example.com`;
  const password = "E2E-staff-password-28";
  await page.goto("/#/team");
  await page.click('[data-action="team-invite"]');
  const invite = page.locator('form[data-form="team-invite"]');
  await invite.locator("input[name=email]").fill(email);
  await invite.locator("select[name=role]").selectOption("staff");
  await invite.locator("button[type=submit]").click();
  const link = await page.locator("input[name=teamlink]").inputValue();
  await page.keyboard.press("Escape");

  const staffContext = await context.browser().newContext();
  const staff = await staffContext.newPage();
  const staffErrors = [];
  staff.on("pageerror", (e) => staffErrors.push(e.message));
  await staff.goto(link);
  const join = staff.locator('form[data-form="team-guest"]');
  await join.locator("input[name=password]").fill(password);
  await join.locator("input[name=confirm]").fill(password);
  await join.locator("button[type=submit]").click();
  await expect(staff.locator(".login-inner")).toContainText(
    "Your account is ready",
  );
  await staff.goto(new URL("/", docUrl).href);
  await staff.fill('form[data-form="login"] input[name=email]', email);
  await staff.fill('form[data-form="login"] input[name=password]', password);
  await staff.click('form[data-form="login"] button[type=submit]');
  await expect(staff.locator(".sidebar")).toBeVisible();

  // Staff see the payment and its receipt, but not Reverse.
  await staff.goto(docUrl);
  await expect(history(staff).locator('a[href$="/receipt"]')).toBeVisible();
  await expect(staff.locator('[data-action="reverse-payment"]')).toHaveCount(0);
  await expect(staff.locator(".activity-panel")).toHaveCount(0);

  // Company figures are not for staff: no money tiles, chart, aging or cash
  // health on the Overview, no totals on Credits, no Reports, Tax or Funding.
  await staff.goto(new URL("/#/overview", docUrl).href);
  await expect(staff.locator("main h1")).toHaveText("Overview");
  await expect(staff.locator(".attention").first()).toBeVisible();
  await expect(staff.locator(".metrics")).toHaveCount(0);
  await expect(staff.locator(".aging-panel")).toHaveCount(0);
  await expect(staff.locator(".books-health")).toHaveCount(0);
  await expect(staff.locator(".tax-watch")).toHaveCount(0);
  for (const label of ["Reports", "Tax", "Funding"])
    await expect(
      staff.locator(".sidebar nav a", { hasText: label }),
    ).toHaveCount(0);
  await expect(
    staff.locator(".sidebar nav a", { hasText: "Bank matching" }),
  ).toHaveCount(1);
  await staff.goto(new URL("/#/ledger", docUrl).href);
  await expect(staff.locator("main h1")).toContainText(
    "Cash and customer credits",
  );
  await expect(staff.locator(".metrics")).toHaveCount(0);
  await expect(staff.locator("main table tbody tr").first()).toBeVisible();
  await staff.goto(docUrl);

  // The same person as a read-only accountant.
  await page.goto("/#/team");
  await page
    .locator("table.team-users tr", { hasText: email })
    .locator('[data-action="team-edit"]')
    .click();
  await page
    .locator('form[data-form="team-edit"] select[name=role]')
    .selectOption("accountant");
  await page.locator('form[data-form="team-edit"] button[type=submit]').click();
  await expect(page.locator("#toast")).toContainText("User updated");
  await staff.reload();
  await expect(staff.locator(".topbar")).toContainText("Accountant");
  await expect(history(staff).locator('a[href$="/receipt"]')).toBeVisible();
  await expect(staff.locator('[data-action="reverse-payment"]')).toHaveCount(0);
  await expect(staff.locator(".activity-panel")).toHaveCount(0);
  // An accountant reads the company figures.
  await staff.goto(new URL("/#/overview", docUrl).href);
  await expect(staff.locator(".metrics").first()).toBeVisible();
  await expect(
    staff.locator(".sidebar nav a", { hasText: "Reports" }),
  ).toHaveCount(1);

  await staffContext.close();
  expect(staffErrors).toEqual([]);
  expect(errors).toEqual([]);
});
