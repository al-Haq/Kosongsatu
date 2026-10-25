import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique, createClient } from "./helpers.mjs";

// An issued quotation can still be edited; the activity says what changed;
// the next quotation starts with the same terms and conditions.
test("quotations: edit after issue, see what changed, reuse the terms", async ({ page }) => {
  test.setTimeout(60000);
  const errors = watchErrors(page);
  await signIn(page);
  const client = unique("E2E Revise");
  await createClient(page, client);
  const terms = `T&C ${unique("VATEX")}: 50% deposit, balance on delivery.`;

  await page.goto("/#/quotes");
  await page.click('[data-action="new-quote"]');
  let editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  await editor.locator(".item-description").first().fill("Asus Vivobook 16");
  await editor.locator(".item-quantity").first().fill("6");
  await editor.locator(".item-rate").first().fill("3800");
  await editor.locator("textarea[name=terms]").fill(terms);
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");
  await page.click('[data-action="issue-document"]');
  await page.click('[data-action="confirm-issue"]');
  await expect(page.locator("#toast")).toContainText("Document issued");
  const number = (await page.locator("main h1").first().textContent()).trim();
  expect(number).toMatch(/^QT-\d{4}-\d{4}$/);

  // Edit it after issue: the client and issue date stay as issued.
  await page.click('[data-action="edit-document"]');
  editor = page.locator('form[data-form="editor"]');
  await expect(page.locator("dialog .modal-head h2")).toHaveText(`Edit quotation ${number}`);
  await expect(editor.locator(".revise-note")).toContainText(number);
  await expect(editor.locator("select[name=client_id]")).toBeDisabled();
  await expect(editor.locator("input[name=issue_date]")).toHaveAttribute("readonly", "");
  await editor.locator(".item-rate").first().fill("3860");
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText(`${number} updated`);
  await expect(page.locator("main h1").first()).toHaveText(number);
  await expect(page.locator(".invoice-paper")).toContainText("23,160.00");

  // The owner's activity says exactly what changed.
  const activity = page.locator(".activity-panel");
  await expect(activity).toContainText("Owner only");
  const edit = activity.locator(".timeline-item", { hasText: "Edited after issue" });
  await expect(edit).toContainText("Line 1 “Asus Vivobook 16”: rate 3,800.00 → 3,860.00");
  await expect(edit).toContainText("Total: 22,800.00 → 23,160.00");

  // The next quotation starts with the same terms, and they can be changed.
  await page.goto("/#/quotes");
  await page.click('[data-action="new-quote"]');
  editor = page.locator('form[data-form="editor"]');
  await expect(editor.locator("textarea[name=terms]")).toHaveValue(terms);
  await expect(editor.locator(".terms-hint")).toContainText(`Same as ${number}`);
  await editor.locator("[data-terms-default]").click();
  await expect(editor.locator("textarea[name=terms]")).not.toHaveValue(terms);
  await expect(editor.locator(".terms-hint")).toContainText("company default");
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});
