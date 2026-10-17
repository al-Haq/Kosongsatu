import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique, createClient } from "./helpers.mjs";

test("invoice: draft, issue, client link, payment and receipt", async ({ page, context }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const client = unique("E2E Client");
  await createClient(page, client);

  await page.goto("/#/invoices");
  await page.click('[data-action="new-invoice"]');
  const editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  await editor.locator(".item-description").first().fill("Website maintenance");
  await editor.locator(".item-quantity").first().fill("2");
  await editor.locator(".item-rate").first().fill("750.50");
  await expect(page.locator("#live-preview")).toContainText("1,501.00");
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");

  await page.click('[data-action="issue-document"]');
  await page.click('[data-action="confirm-issue"]');
  await expect(page.locator("#toast")).toContainText("Document issued");
  const number = (await page.locator("main h1").first().textContent()).trim();
  expect(number).toMatch(/^INV-\d{4}-\d{4}$/);

  await page.click('[data-action="share-document"]');
  await page.click('[data-action="generate-link"]');
  const link = await page.locator("input[name=shareurl]").inputValue();
  expect(link).toMatch(/\/client\/[\w-]{43}$/);
  await page.click('[data-action="close-modal"]');

  // The client sees the invoice without signing in and submits a reference.
  const guest = await context.browser().newPage();
  const guestErrors = watchErrors(guest);
  await guest.goto(link);
  await expect(guest.locator("h1")).toContainText(number);
  await expect(guest.locator(".balance-card .value")).toContainText("1,501.00");
  await guest.click('[data-action="public-reference"]');
  await guest.fill('form[data-form="public-reference"] input[name=reference]', "FPX123456");
  await guest.click('form[data-form="public-reference"] button[type=submit]');
  await expect(guest.locator("#toast")).toContainText("Reference submitted");
  expect(guestErrors).toEqual([]);
  await guest.close();

  // The owner confirms the money and records it against the reference.
  await page.reload();
  await expect(page.locator("text=FPX123456").first()).toBeVisible();
  await page.click('[data-action="record-payment"]');
  const pay = page.locator('form[data-form="payment"]');
  await pay.locator("input[name=reference]").fill("FPX123456");
  // Link the payment to the client's submitted reference so it is confirmed.
  await pay.locator("select[name=proof_id]").selectOption({ label: "FPX123456" });
  await pay.locator("input[name=confirmed]").check();
  await pay.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Payment confirmed");
  await expect(page.locator(".panel .badge", { hasText: "Paid" }).first()).toBeVisible();
  await expect(page.locator(".panel h2", { hasText: "Awaiting review" })).toHaveCount(0);
  const confirmed = await context.browser().newPage();
  await confirmed.goto(link);
  await expect(confirmed.locator(".payment", { hasText: "FPX123456" }).locator(".badge")).toHaveText("Confirmed");
  await confirmed.close();

  const pdf = await page.request.get(page.url().replace(/#\/document\/([\w-]+)$/, "api/documents/$1/pdf"));
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(errors).toEqual([]);
});

test("quotation: client accepts online and the owner converts it", async ({ page, context }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const client = unique("E2E Quote Client");
  await createClient(page, client);
  await page.goto("/#/quotes");
  await page.click('[data-action="new-quote"]');
  const editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  await editor.locator(".item-description").first().fill("Network setup");
  await editor.locator(".item-rate").first().fill("2400");
  await editor.locator("button[type=submit]").click();
  await page.click('[data-action="issue-document"]');
  await page.click('[data-action="confirm-issue"]');
  await page.click('[data-action="share-document"]');
  await page.click('[data-action="generate-link"]');
  const link = await page.locator("input[name=shareurl]").inputValue();

  const guest = await context.browser().newPage();
  await guest.goto(link);
  await guest.click('[data-action="public-accept"]');
  // The client signs on a pad before accepting.
  const accept = guest.locator("form.portal-sign");
  await accept.locator("input[name=name]").fill("Aminah Binti Ali");
  const pad = await accept.locator(".portal-sign-draw canvas").boundingBox();
  await guest.mouse.move(pad.x + 30, pad.y + pad.height / 2);
  await guest.mouse.down();
  for (const [dx, dy] of [[60, -20], [120, 25], [180, -15], [240, 20], [300, 0]])
    await guest.mouse.move(pad.x + 30 + dx, pad.y + pad.height / 2 + dy, { steps: 4 });
  await guest.mouse.up();
  await accept.locator("input[name=agree]").check();
  await accept.locator("button[type=submit]").click();
  await expect(guest.locator("#toast")).toContainText("Quotation accepted");
  await expect(guest.locator(".portal-signature img")).toBeVisible();
  await guest.close();

  await page.reload();
  await expect(page.locator(".panel .badge", { hasText: "Accepted" }).first()).toBeVisible();
  await page.click('[data-action="convert-quote"]');
  await expect(page.locator("#toast")).toContainText("draft invoice");
  await expect(page.locator("main h1").first()).toContainText("Draft invoice");
  expect(errors).toEqual([]);
});
