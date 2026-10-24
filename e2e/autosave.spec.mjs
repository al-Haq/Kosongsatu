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

  // A save that reached the server but whose answer was lost is not done twice
  // when the restored draft is sent again after a reload: its request key is kept.
  const answerLost = (pattern) =>
    page.route(
      pattern,
      async (route) => {
        await route.fetch();
        await route.abort("internetdisconnected");
      },
      { times: 1 },
    );
  const once = unique("Answer Lost Client");
  await page.goto("/#/clients");
  await page.click('[data-action="new-client"]');
  const clientForm = page.locator('form[data-form="client"]');
  await clientForm.locator("input[name=name]").fill(once);
  await answerLost("**/api/clients");
  await clientForm.locator("button[type=submit]").click();
  await expect(clientForm.locator(".form-error")).toContainText("No connection");
  await page.reload();
  await page.locator('.autosave-pending [data-autosave-pending="open"]').click();
  await expect(clientForm.locator("input[name=name]")).toHaveValue(once);
  await clientForm.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("saved");
  expect(await page.evaluate(async (name) => (await (await fetch("/api/workspace")).json()).clients.filter((c) => c.name === name).length, once)).toBe(1);
  expect(await drafts(page)).toEqual([]);

  // The same for a module form with its own request key: a stock adjustment.
  await page.goto("/#/inventory");
  if (await page.locator('[data-action="ops-inventory-on"]').count()) await page.click('[data-action="ops-inventory-on"]');
  await page.click('main [data-action="ops-stock-track"]');
  const track = page.locator('form[data-form="ops-stock-track"]');
  const item = (await track.locator("select[name=service_id] option:checked").textContent()).replace(/ \([^)]*\)$/, "");
  await track.locator("input[name=opening]").fill("10");
  await track.locator("button[type=submit]").click();
  const stockRow = page.locator("main tr", { hasText: item });
  await expect(stockRow.locator("td").nth(2)).toHaveText("10");
  await stockRow.locator('[data-action="ops-stock-adjust"]').click();
  const move = page.locator('form[data-form="ops-stock-move"]');
  await move.locator("input[name=quantity]").fill("-2");
  await move.locator("input[name=reason]").fill("Damaged in transit");
  await answerLost("**/api/ops/stock/*/movements");
  await move.locator("button[type=submit]").click();
  await expect(move.locator(".form-error")).not.toBeEmpty();
  await page.reload();
  await expect(stockRow.locator("td").nth(2)).toHaveText("8");
  await stockRow.locator('[data-action="ops-stock-adjust"]').click();
  await expect(move.locator(".autosave-notice")).toBeVisible();
  await expect(move.locator("input[name=reason]")).toHaveValue("Damaged in transit");
  await move.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Stock updated");
  await expect(stockRow.locator("td").nth(2)).toHaveText("8");
  expect(await drafts(page)).toEqual([]);
  await page.click('[data-action="ops-inventory-off"]');

  // A restored email keeps its edited subject and message: putting the language
  // back does not load that language's template over them. (Mail is reported as
  // set up so the email fields show; nothing is sent.)
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, mail: { ...json.mail, configured: true } } });
  });
  const openStatement = async () => {
    await page.goto("/#/clients");
    await page.locator('main tr[data-action="open-client"]', { hasText: client }).click();
    await page.click('main [data-action="client-statement"]');
  };
  await openStatement();
  const statement = page.locator('form[data-form="statement"]');
  const subject = statement.locator("input[name=subject]");
  const template = await subject.inputValue();
  const other = (await statement.locator("select[name=language]").inputValue()) === "en" ? "ms" : "en";
  await statement.locator("select[name=language]").selectOption(other);
  await expect(subject).not.toHaveValue(template);
  await subject.fill("Your statement, as promised");
  await statement.locator("textarea[name=message]").fill("Hi, the statement we spoke about is attached.");
  await expect.poll(() => drafts(page)).toHaveLength(1);
  await page.reload();
  const templateLoaded = page.waitForResponse((r) => r.url().includes("/api/comms/compose") && r.url().includes("language=" + other));
  await openStatement();
  await expect(statement.locator(".autosave-notice")).toBeVisible();
  await templateLoaded;
  await page.waitForTimeout(200);
  await expect(statement.locator("select[name=language]")).toHaveValue(other);
  await expect(subject).toHaveValue("Your statement, as promised");
  await expect(statement.locator("textarea[name=message]")).toHaveValue("Hi, the statement we spoke about is attached.");
  await page.locator('#modal [data-action="close-modal"]').first().click();
  expect(await drafts(page)).toEqual([]);
  await page.unroute("**/api/workspace");

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

  // Leaving the page straight after typing still files the draft under Settings.
  await company.fill("Typed then left");
  await page.click('.sidebar a[href="#/invoices"]');
  await expect(page.locator("main h1")).toHaveText("Invoices");
  await page.reload();
  await page.locator('.autosave-pending [data-autosave-pending="open"]').click();
  await expect(page.locator('form[data-form="settings"] .autosave-notice')).toBeVisible();
  await expect(company).toHaveValue("Typed then left");
  await page.click('form[data-form="settings"] [data-autosave-discard]');
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

  // A draft belongs to its parent record: a milestone typed under one project
  // never opens under another, and comes back under its own.
  const project = async (name) => {
    await page.goto("/#/projects");
    await page.click('[data-action="ops-project-new"]');
    const form = page.locator('form[data-form="ops-project-save"]');
    await form.locator("select[name=client_id]").selectOption({ label: client });
    await form.locator("input[name=name]").fill(name);
    await form.locator("button[type=submit]").click();
    await expect(page.locator("main h1")).toHaveText(name);
    expect(await drafts(page)).toEqual([]);
    return page.url();
  };
  const projectA = await project(unique("Project A"));
  const projectB = await project(unique("Project B"));
  const milestone = page.locator('form[data-form="ops-ms-save"]');
  await page.goto(projectA);
  await page.click('[data-action="ops-ms-new"]');
  await milestone.locator("input[name=name]").fill("Design sign-off");
  await expect.poll(() => drafts(page)).toHaveLength(1);
  await page.reload();
  await page.goto(projectB);
  await page.click('[data-action="ops-ms-new"]');
  await expect(milestone.locator("input[name=name]")).toHaveValue("");
  await expect(milestone.locator(".autosave-notice")).toHaveCount(0);
  await page.locator('#modal [data-action="close-modal"]').first().click();
  expect(await drafts(page)).toHaveLength(1);
  await page.goto(projectA);
  await page.click('[data-action="ops-ms-new"]');
  await expect(milestone.locator(".autosave-notice")).toBeVisible();
  await expect(milestone.locator("input[name=name]")).toHaveValue("Design sign-off");
  await page.locator('#modal [data-action="close-modal"]').first().click();
  expect(await drafts(page)).toEqual([]);

  // Rows changed in a form that has no hook are not kept, rather than restored
  // into the wrong rows: a row added, or a saved row removed and a new one added.
  await page.goto("/#/settings/documents");
  const fieldRows = page.locator('form[data-form="doc-custom-fields"] .custom-field-row');
  const label = unique("Field");
  await page.click('[data-action="doc-field-add"]');
  await fieldRows.last().locator("input[name=label]").fill(label);
  await page.waitForTimeout(700);
  expect(await drafts(page)).toEqual([]);
  await page.locator('form[data-form="doc-custom-fields"] button[type=submit]').click();
  await expect(page.locator("#toast")).toBeVisible();
  const kept = await fieldRows.count();
  await fieldRows.filter({ has: page.locator(`input[name=label][value="${label}"]`) }).locator('[data-action="doc-field-remove"]').click();
  await page.click('[data-action="doc-field-add"]');
  await fieldRows.last().locator("input[name=label]").fill("PO number");
  await expect(fieldRows).toHaveCount(kept);
  await page.waitForTimeout(700);
  expect(await drafts(page)).toEqual([]);
  // Put the workspace back for the other tests.
  await fieldRows.last().locator('[data-action="doc-field-remove"]').click();
  await page.locator('form[data-form="doc-custom-fields"] button[type=submit]').click();
  await expect(fieldRows).toHaveCount(kept - 1);

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
