// Optional modules the owner can turn off in Settings > Modules for a shorter
// menu. Turning one off hides its menu entries (nav keys), its Overview panels
// (by browser module name) and its Settings sections (by panel heading), and
// nothing else: records, server routes, jobs and client links keep working,
// and turning it back on brings everything back.
// Core (Overview, quotations and invoices, clients, services, payments and
// receipts, Settings, team) is not listed, so it cannot be turned off.
// Shared by the browser (public/app.mjs, public/ext/setup.mjs) and the server
// (server/ext/setup.mjs), which accepts only these keys.
// Recurring lists no Settings sections: late payment fees and the monthly
// accountant pack (drawn by that browser module) apply to every invoice.
export const MODULES = [
  { key: "sales", label: "Sales pipeline", about: "Opportunities, quotations awaiting acceptance and customer POs.", nav: ["sales"] },
  { key: "proforma", label: "Proforma invoices", about: "Ask for payment before the real invoice.", nav: ["proformas"] },
  { key: "orders", label: "Sales and delivery orders", about: "Confirm orders, and deliver goods with a signed delivery order.", nav: ["sales-orders", "delivery-orders"] },
  { key: "recurring", label: "Recurring billing", about: "Plans that draft invoices on a schedule, and service contracts.", nav: ["recurring"], overview: ["recurring"] },
  { key: "bank", label: "Bank matching", about: "Import a bank statement and match it to invoices.", nav: ["bank"] },
  { key: "books", label: "Expenses, bills and reports", about: "Spending, supplier bills, profit and loss, and cash flow.", nav: ["expenses", "bills", "reports"], overview: ["books"], settings: ["Books"] },
  { key: "tax", label: "Tax and e-Invoice", about: "SST-02 returns, exemptions and LHDN MyInvois e-Invoices.", nav: ["tax"], overview: ["tax"], settings: ["Tax"] },
  { key: "ops", label: "Projects, timesheets and inventory", about: "Track jobs and hours, bill them, and keep stock counts.", nav: ["projects", "timesheets", "inventory"], overview: ["ops"], settings: ["Operations"] },
  { key: "portal", label: "Client portal and feedback", about: "Clients sign in to see their documents and rate your work.", nav: ["feedback"], overview: ["portal"], settings: ["Client portal and feedback"] },
  { key: "automation", label: "Automation and assistant", about: "Rules and the AI assistant suggest work for you to approve.", nav: ["automation"] },
  { key: "webhooks", label: "Webhooks", about: "Tell other systems when invoices and payments change.", nav: ["webhooks"] },
];
export const MODULE_KEYS = MODULES.map((m) => m.key);
// Whether the owner turned a module off. A missing key means on, so existing
// installs keep everything after an upgrade.
export const moduleOff = (settings, key) => !!key && settings?.modules?.[key] === false;
const byNav = new Map(MODULES.flatMap((m) => m.nav.map((n) => [n, m.key])));
const byPlugin = new Map(MODULES.flatMap((m) => (m.overview || []).map((p) => [p, m.key])));
// The module a menu entry belongs to (null for core entries).
export const navModule = (navKey) => byNav.get(navKey) || null;
// The module whose Overview panels a browser module draws.
export const overviewModule = (pluginName) => byPlugin.get(pluginName) || null;
// Settings panel headings hidden while their module is off.
export const hiddenSettings = (settings) =>
  new Set(MODULES.filter((m) => moduleOff(settings, m.key)).flatMap((m) => m.settings || []));
// The name a new workspace starts with (server/db.mjs): not yet the business's own.
export const DEFAULT_COMPANY = "NAWLOGIC SYSTEMS SOLUTION";
export const ownCompany = (settings) => {
  const name = String(settings?.company || "").trim();
  return name && name.toUpperCase() !== DEFAULT_COMPANY ? name : "";
};
