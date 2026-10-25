// The logo at the top of PDFs that are not documents (reports, purchase
// orders, the accountant pack, SST-02, self-billed e-Invoices): the business's
// own once it has uploaded one in Settings > Documents, otherwise Nawlogic's.
// Documents (invoices, quotations, receipts...) use the logo kept with them.
import { fileURLToPath } from "node:url";

export const DEFAULT_LOGO = fileURLToPath(new URL("../public/assets/nawlogic-logo.png", import.meta.url));

// The current business logo (PNG or JPEG bytes), or null.
export function businessLogo(store) {
  try {
    return store?.logoFor?.(store.settings())?.data || null;
  } catch {
    return null;
  }
}

// The logo kept with an issued record (its business snapshot), so a later
// upload, change or removal does not change it; one issued before the
// business had a logo takes the current one instead of the placeholder.
export function snapshotLogo(store, business) {
  try {
    return store?.logoFor?.({ logoFileId: business?.logoFileId || null, frozen: true })?.data || null;
  } catch {
    return null;
  }
}

// Pixel size of a PNG or JPEG, or null.
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length; ) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1],
        length = buf.readUInt16BE(i + 2);
      // Start-of-frame markers (not DHT, JPG or DAC) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + length;
    }
  }
  return null;
}
// The largest size that fits a box without changing the shape.
export function fitBox(size, maxWidth, maxHeight) {
  if (!size?.width || !size?.height) return { width: maxWidth, height: Math.round((maxWidth * 106) / 400) };
  const scale = Math.min(maxWidth / size.width, maxHeight / size.height, 1);
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

export function drawLogoImage(pdf, custom, x, y, width, height = 48) {
  if (custom)
    try {
      pdf.image(custom, x, y, { fit: [width, height] });
      return;
    } catch {
      // An unreadable image falls back to the default logo.
    }
  pdf.image(DEFAULT_LOGO, x, y, { width });
}
