import { test, expect } from "@playwright/test";
import { signIn, watchErrors } from "./helpers.mjs";

// Money from the owner, a director or an investor is recorded under Funding,
// apart from customer receipts; a loan shows what is still owed.
test("funding: capital, a loan and its repayment, with the balance still owed", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await signIn(page);

  // The Credits form points owner money here.
  await page.goto("/#/ledger");
  await page.click('[data-action="cash-receive"]');
  await expect(page.locator("dialog")).toContainText("record it under Funding");
  await page.keyboard.press("Escape");

  await page.goto("/#/funding");
  await expect(page.locator("h1")).toHaveText("Owner and investor funding");
  const stamp = Date.now().toString(36);
  const investor = `Investor ${stamp}`;

  // Capital.
  await page.click('[data-action="funding-new"]');
  const form = page.locator('form[data-form="funding-record"]');
  await expect(form.locator("input[name=kind][value=capital]")).toBeChecked();
  await expect(form.locator("select[name=loan_id]")).toBeHidden();
  await form.locator("input[name=party]").fill(investor);
  await form.locator("select[name=role]").selectOption("investor");
  await form.locator("input[name=amount]").fill("10000");
  await form.locator("input[name=reference]").fill(`CAP-${stamp}`);
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Funding recorded.");

  // A loan from the same person: the person and role fields hide for a repayment only.
  await page.click('[data-action="funding-new"]');
  await form.getByText("Loan to the business", { exact: true }).click();
  await expect(form.locator("input[name=party]")).toBeVisible();
  await form.locator("input[name=party]").fill(investor);
  await form.locator("select[name=role]").selectOption("investor");
  await form.locator("input[name=amount]").fill("5000");
  await form.locator("input[name=reference]").fill(`LOAN-${stamp}`);
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Funding recorded.");

  const person = page.locator("tr", { hasText: investor }).first();
  await expect(person).toContainText("RM 10,000.00");
  await expect(person).toContainText("RM 5,000.00");

  // Repay part of it from the loan's row.
  const loanRow = page.locator("tr", { hasText: `LOAN-${stamp}` });
  await loanRow.locator('[data-action="funding-repay"]').click();
  await expect(form.locator("input[name=kind][value=repayment]")).toBeChecked();
  await expect(form.locator("input[name=party]")).toBeHidden();
  await expect(form.locator("select[name=loan_id]")).toBeVisible();
  await expect(
    form.locator("select[name=loan_id] option:checked"),
  ).toContainText(investor);
  // More than is owed is refused with the amount that is.
  await form.locator("input[name=amount]").fill("6000");
  await form.locator("button[type=submit]").click();
  await expect(form.getByRole("alert")).toContainText(
    "more than what is still owed",
  );
  await form.locator("input[name=amount]").fill("1000");
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Repayment recorded.");
  await expect(loanRow.locator('[data-label="Still owed"]')).toContainText(
    "RM 4,000.00",
  );
  // The person's row (the demo workspace has other lenders too).
  await expect(person.locator('[data-label="Still owed"]')).toContainText(
    "RM 4,000.00",
  );

  // A loan with repayments cannot be voided (no Void button); the repayment can.
  await expect(loanRow.locator('[data-action="funding-void"]')).toHaveCount(0);
  const repayRow = page
    .locator("tr", { hasText: "Loan repayment" })
    .filter({ hasText: investor });
  await repayRow.locator('[data-action="funding-void"]').click();
  await page
    .locator('form[data-form="funding-void"] textarea[name=reason]')
    .fill("Wrong amount");
  await page
    .locator('form[data-form="funding-void"] button[type=submit]')
    .click();
  await expect(page.locator("#toast")).toContainText("Entry voided.");
  await expect(loanRow.locator('[data-label="Still owed"]')).toContainText(
    "RM 5,000.00",
  );
  await expect(person.locator('[data-label="Still owed"]')).toContainText(
    "RM 5,000.00",
  );
  await expect(loanRow.locator('[data-action="funding-void"]')).toHaveCount(1);
  // The refused repayment and the empty-reason void answer 400 on purpose.
  expect(errors.filter((e) => !/status of 4\d\d/.test(e))).toEqual([]);
});
