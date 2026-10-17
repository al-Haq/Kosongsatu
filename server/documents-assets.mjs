// PDF resources (custom logo, Chinese font setting) for a document's business
// snapshot. Hydrated documents, receipts and statements bind their business
// object to the store they came from, so renderPdf() can find the logo without
// every caller passing extra arguments. Nothing here is serialized to JSON.
const stores = new WeakMap();
export function bindPdf(business, store) {
  if (business && typeof business === "object") stores.set(business, store);
  return business;
}
// Marks a business snapshot as frozen (issued document, receipt), so the PDF
// never falls back to the current logo. Not enumerable: never serialised.
export function freezeBusiness(business) {
  if (business && typeof business === "object" && !business.frozen)
    Object.defineProperty(business, "frozen", { value: true, enumerable: false, configurable: true });
  return business;
}
export const pdfStore = (business) => (business && typeof business === "object" && stores.get(business)) || null;
