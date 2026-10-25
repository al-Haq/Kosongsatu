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
