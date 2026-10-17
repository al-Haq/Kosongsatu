// Roles and the server-side allow-list. The owner may do everything. Staff and
// accountants may only use the routes listed here (or listed by another module
// through its `access` export); any other owner route is refused, so routes
// added later stay owner-only until someone classifies them.
export const ROLES = ["owner", "staff", "accountant"];
export const ROLE_INFO = {
  owner: {
    label: "Owner",
    summary: "Everything, including settings, integration keys, users, connectors, backups and deletes.",
  },
  staff: {
    label: "Staff",
    summary:
      "Day-to-day billing: clients, services, drafts, issue, share, email, record payments and receipts. No settings, keys, users, connectors, backups, voids, refunds or client deletes.",
  },
  accountant: {
    label: "Accountant",
    summary: "Read-only: views everything, downloads PDFs, CSV/JSON exports and reports, verifies the audit chain. Changes only their own password and MFA.",
  },
};

const id = "[\\w-]+";
const re = (s) => new RegExp("^/api/" + s + "$");
const rule = (method, s) => [method, re(s)];

// Every signed-in user: their own session, password and authenticator.
const SELF = [
  rule("GET", "session"),
  rule("POST", "logout"),
  rule("GET", "mfa/status"),
  rule("POST", "mfa/(begin|enable|disable)"),
  rule("POST", "team/password"),
  rule("GET", "team/me"),
];

// Read-only routes for staff and accountants.
const READ = [
  rule("GET", "workspace"),
  rule("GET", "documents"),
  rule("GET", `documents/${id}`),
  rule("GET", `documents/${id}/pdf`),
  rule("GET", `receipts/${id}/pdf`),
  rule("GET", `payments/${id}/receipt`),
  rule("GET", `(adjustments|refunds)/${id}/pdf`),
  rule("GET", `clients/${id}/statement`),
  rule("GET", `clients/${id}/statement/pdf`),
  rule("GET", "invoices\\.csv"),
  rule("GET", "reports/sst"),
  rule("GET", "reports/sst\\.csv"),
  rule("GET", "files"),
  rule("GET", `files/${id}`),
];

const STAFF = [
  rule("POST", "documents"),
  rule("PUT", `documents/${id}`),
  rule("DELETE", `documents/${id}`), // drafts only; the store refuses issued documents
  rule("POST", `documents/${id}/(issue|share|revoke|email|duplicate|convert|payments)`),
  rule("POST", "clients"),
  rule("PUT", `clients/${id}`),
  rule("POST", `clients/${id}/(archive|restore)`),
  rule("POST", `clients/${id}/statement/email`),
  rule("POST", "services"),
  rule("PUT", `services/${id}`),
  rule("POST", "receipts"),
  rule("POST", `receipts/${id}/allocate`),
  rule("POST", "schedules"),
  rule("PUT", `schedules/${id}`),
  rule("POST", `schedules/${id}/(run|pause|resume)`),
  rule("POST", "bank/(preview|import)"),
  rule("POST", `bank/${id}/(match|receive)`),
  rule("POST", `proofs/${id}/reject`),
  rule("POST", `online-payments/${id}/check`),
  rule("POST", "sales/opportunities"),
  rule("PUT", `sales/opportunities/${id}`),
  rule("POST", `sales/quotes/${id}/accept`),
  rule("POST", "sales/customer-pos"),
  rule("POST", `sales/customer-pos/${id}/invoice`),
  rule("POST", "files"),
];

const ACCOUNTANT = [
  rule("GET", "backup"), // JSON business export (not a restore image)
  rule("GET", "team/audit/(verify|head)"),
];

const BASE = {
  staff: [...SELF, ...READ, ...STAFF],
  accountant: [...SELF, ...READ, ...ACCOUNTANT],
};

// Other modules classify their own routes with
//   export default { access: { staff: [["GET", /^\/api\/x$/]], accountant: [...] } }
export function accessRules(plugins = []) {
  const out = { staff: [...BASE.staff], accountant: [...BASE.accountant] };
  for (const p of plugins)
    for (const role of ["staff", "accountant"])
      for (const [method, pattern] of p.access?.[role] || [])
        if (typeof method === "string" && pattern instanceof RegExp) out[role].push([method.toUpperCase(), pattern]);
  return out;
}

export function allowed(rules, role, method, path) {
  if (role === "owner") return true;
  return (rules[role] || []).some(([m, p]) => m === method && p.test(path));
}
