import { test, expect } from "@playwright/test";
import { signIn, watchErrors } from "./helpers.mjs";

// A picture of any size works as the logo: large ones are scaled down in the
// browser before upload, WebP is converted, and a tiny one is accepted with a note.
test("logo upload: a 3000 px photo-sized PNG is resized, WebP converted, a tiny logo warned about", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto("/#/settings/documents");
  const form = page.locator('form[data-form="doc-logo"]');
  const input = form.locator("input[type=file]");

  // Pictures are drawn in the page (noisy, so they are big like real photos).
  const picture = (width, height, type) =>
    page.evaluate(
      ({ width, height, type }) => {
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        const ctx = c.getContext("2d");
        // Random noise does not compress, so the PNG is as big as a photo.
        const img = ctx.createImageData(width, height);
        for (let at = 0; at < img.data.length; at += 65536)
          crypto.getRandomValues(
            img.data.subarray(at, Math.min(at + 65536, img.data.length)),
          );
        for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
        ctx.putImageData(img, 0, 0);
        return c.toDataURL(type).split(",")[1];
      },
      { width, height, type },
    );
  const stored = () =>
    page.evaluate(async () => {
      const { settings } = await (await fetch("/api/workspace")).json();
      const blob = await (
        await fetch(`/api/files/${settings.logoFileId}`)
      ).blob();
      const bitmap = await createImageBitmap(blob);
      return {
        size: blob.size,
        type: blob.type,
        width: bitmap.width,
        height: bitmap.height,
      };
    });

  // 3000×750 PNG of noise, several MB (a worst case): scaled down to under 1 MB, at least 1200 px wide.
  const big = Buffer.from(await picture(3000, 750, "image/png"), "base64");
  expect(big.length).toBeGreaterThan(1024 * 1024);
  await input.setInputFiles({
    name: "big-logo.png",
    mimeType: "image/png",
    buffer: big,
  });
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Logo saved");
  await expect(page.locator("#toast")).toContainText(
    "Resized from 3000×750 to ",
  );
  let logo = await stored();
  expect(logo.width).toBeLessThanOrEqual(2000);
  expect(logo.width).toBeGreaterThanOrEqual(1200);
  expect(logo.height).toBe(logo.width / 4);
  expect(logo.size).toBeLessThanOrEqual(1024 * 1024);
  await expect(page.locator(".sidebar img.brand-logo")).toBeVisible();

  // WebP is converted (the server takes PNG and JPEG only).
  const webp = Buffer.from(await picture(800, 200, "image/webp"), "base64");
  await input.setInputFiles({
    name: "logo.webp",
    mimeType: "image/webp",
    buffer: webp,
  });
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Converted to PNG");
  logo = await stored();
  expect(logo.type).toBe("image/png");
  expect(logo.width).toBe(800);

  // A tiny picture is accepted as it is, with a note that it may print blurry.
  const tiny = Buffer.from(await picture(200, 50, "image/png"), "base64");
  await input.setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: tiny,
  });
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("may print blurry");
  logo = await stored();
  expect(logo.width).toBe(200);

  // Not a picture at all: a clear message, nothing uploaded.
  await input.setInputFiles({
    name: "notes.png",
    mimeType: "image/png",
    buffer: Buffer.from("hello"),
  });
  await form.locator("button[type=submit]").click();
  await expect(form.getByRole("alert")).toContainText(
    "not a picture the browser can read",
  );
  expect((await stored()).width).toBe(200);

  // Back to the Nawlogic logo: other tests expect a workspace without one.
  await page.keyboard.press("Escape");
  await page.click('[data-action="doc-logo-remove"]');
  await expect(page.locator("#toast")).toContainText("Nawlogic logo again");
  await expect(
    page.locator('.sidebar img.logo[src="/assets/nawlogic-logo.png"]'),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
