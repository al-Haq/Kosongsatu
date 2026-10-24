import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique, createClient } from "./helpers.mjs";

const drafts = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("nawlogic.draft:")));

test("autosave: unsaved input survives a reload or a lost connection, and is restored, discarded or saved", async ({ page, context }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const client = unique("Autosave Client");
  await createClient(page, client);

  // A new invoice with two lines, not saved yet.
  await page.goto("/#/invoices");
  await page.click('[data-action="new-invoice"]');
  let editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  await editor.locator(".item-description").first().fill("Server migration");
  await editor.locator(".item-rate").first().fill("1200.00");
  await page.click('[data-action="add-line"]');
  await editor.locator(".item-description").nth(1).fill("Training day");
  await editor.locator(".item-rate").nth(1).fill("800.00");
  await editor.locator("textarea[name=notes]").fill("Phase one");
  await expect.poll(() => drafts(page)).toHaveLength(1);

  // The tab closes or the power goes before Save; on return the work is offered back.
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
  const pending = page.locator(".autosave-pending");
  await expect(pending).toContainText("New invoice");
  await pending.locator('[data-autosave-pending="open"]').click();
  editor = page.locator('form[data-form="editor"]');
  await expect(editor.locator(".autosave-notice")).toContainText("Restored what you typed");
  await expect(editor.locator("select[name=client_id] option:checked")).toHaveText(client);
  await expect(editor.locator(".line-item")).toHaveCount(2);
  await expect(editor.locator(".item-description").nth(1)).toHaveValue("Training day");
  await expect(editor.locator("textarea[name=notes]")).toHaveValue("Phase one");
  await expect(page.locator("#live-preview")).toContainText("2,000.00");

  // Offline: Save explains what happened and nothing typed is lost.
  await context.setOffline(true);
  await expect(page.locator("#offline-banner")).toBeVisible();
  await editor.locator("button[type=submit]").click();
  await expect(editor.locator(".form-error")).toContainText("No connection");
  await expect(editor.locator(".item-description").first()).toHaveValue("Server migration");
  await context.setOffline(false);
  await expect(page.locator("#offline-banner")).toHaveCount(0);
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");
  await expect(page.locator("main")).toContainText("Training day");
  expect(await drafts(page)).toEqual([]);

  // Cancel means "do not keep it".
  await page.goto("/#/clients");
  await page.click('[data-action="new-client"]');
  await page.locator('form[data-form="client"] input[name=name]').fill("Typed then cancelled");
  await expect.poll(() => drafts(page)).toHaveLength(1);
  await page.locator('#modal .form-actions [data-action="close-modal"]').click();
  expect(await drafts(page)).toEqual([]);

  // A form on a page: Settings keeps an unsaved edit across a reload; Discard brings back the saved value.
  await page.goto("/#/settings");
  const company = page.locator('form[data-form="settings"] input[name=company]');
  const saved = await company.inputValue();
  await company.fill("Half-typed name");
  await expect.poll(() => drafts(page)).toHaveLength(1);
  await page.reload();
  await expect(page.locator('form[data-form="settings"] .autosave-notice')).toBeVisible();
  await expect(company).toHaveValue("Half-typed name");
  await expect(page.locator(".autosave-pending")).toHaveCount(0);
  await page.click('form[data-form="settings"] [data-autosave-discard]');
  await expect(company).toHaveValue(saved);
  expect(await drafts(page)).toEqual([]);

  // A recurring plan's lines are kept too (a module hook), and Open brings the plan back.
  await page.goto("/#/recurring");
  await page.click('[data-action="rec-plan-new"]');
  const plan = page.locator('form[data-form="rec-plan"]');
  await plan.locator("select[name=client_id]").selectOption({ label: client });
  await plan.locator("input[name=title]").fill("Hosting plan");
  await plan.locator('.rec-line [data-field="description"]').first().fill("Hosting");
  await plan.locator('.rec-line [data-field="rate"]').first().fill("150.00");
  await page.click('[data-action="rec-line-add"]');
  await plan.locator('.rec-line [data-field="description"]').nth(1).fill("Backups");
  await expect.poll(() => drafts(page)).toHaveLength(1);
  await page.reload();
  await page.locator('.autosave-pending [data-autosave-pending="open"]').click();
  await expect(plan.locator(".autosave-notice")).toBeVisible();
  await expect(plan.locator("input[name=title]")).toHaveValue("Hosting plan");
  await expect(plan.locator(".rec-lines-body .rec-line")).toHaveCount(2);
  await expect(plan.locator('.rec-line [data-field="rate"]').first()).toHaveValue("150.00");
  await expect(plan.locator('.rec-line [data-field="description"]').nth(1)).toHaveValue("Backups");
  await page.locator('#modal [data-action="close-modal"]').first().click();
  expect(await drafts(page)).toEqual([]);

  // Rows added to a form that has no hook are not kept, rather than restored by half.
  await page.goto("/#/settings/documents");
  await page.click('[data-action="doc-field-add"]');
  await page.locator(".custom-field-row input[name=label]").last().fill("Project code");
  await page.waitForTimeout(700);
  expect(await drafts(page)).toEqual([]);

  // Passwords are never kept.
  await page.goto("/#/settings/security");
  await page.locator('form[data-form="password"] input[name=current]').fill("Never-kept-password-1");
  await page.waitForTimeout(700);
  expect(await drafts(page)).toEqual([]);

  // Signing out removes this user's drafts from the device.
  await page.goto("/#/settings");
  await company.fill("Another edit");
  await expect.poll(() => drafts(page)).toHaveLength(1);
  await page.click(".avatar-menu summary");
  await page.click('[data-action="logout"]');
  await expect(page.locator('form[data-form="login"]')).toBeVisible();
  expect(await drafts(page)).toEqual([]);
  // Requests made while offline fail by design.
  expect(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(e))).toEqual([]);
});
