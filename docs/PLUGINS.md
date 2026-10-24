# Feature modules

Kosongsatu's core (documents, finance, banking, sales, automation) lives in `server/*.mjs` and `public/app.mjs`. Larger features are **modules**: one server file in `server/ext/<name>.mjs`, one browser file in `public/ext/<name>.mjs` and one stylesheet in `public/ext/<name>.css`. They are listed in `server/plugins.mjs` and `public/plugins.mjs`.

A module can add tables, Store methods, routes, background jobs, Settings keys, PDF blocks and screens without editing core files. Edit a core file only when a feature changes core behaviour, and keep that change small.

Modules: `documents`, `recurring`, `tax`, `payments`, `comms`, `portal`, `books`, `ops`, `team`, `platform`, `setup`, `trash`.

The owner can turn optional modules off in Settings > Modules (`setup`). To make yours optional, add it to `MODULES` in `public/ext/setup-modules.mjs` with its nav keys, the browser module whose `overview` slot it owns and its Settings section headings. While it is off those are hidden; its routes, jobs and data keep working.

## Server module

```js
// server/ext/example.mjs
export default {
  name: "example",
  // Run once each, in order, recorded by name in schema_migrations.
  // Names must start with the module name. Use { name, up(db) } for code,
  // and foreignKeysOff: true for a table rebuild.
  migrations: [{ name: "example-001-things", sql: "CREATE TABLE things(...);" }],
  // Keys the owner can enter in Settings > Integration keys (encrypted).
  // Read them with store.config(NAME): the server environment wins.
  secrets: [{ name: "EXAMPLE_API_KEY", label: "Example API key", help: "From Example > Developers", secret: true }],
  // Add or wrap Store methods (the core idiom; keep the original call).
  attach(Store) {
    const original = Store.prototype.saveClient;
    Store.prototype.saveClient = function (b, id) {
      const out = original.call(this, b, id);
      // ...save this module's extra client fields
      return out;
    };
  },
  // Called once per createApp. ctx = { store, appUrl, secure, mailer, gateway,
  // assistant, backups, services }. Put shared services on ctx.services.
  init(ctx) {},
  routes: {
    // Owner API, after sign-in and CSRF checks. Return true when handled.
    async owner(r) {
      if (r.path === "/api/example" && r.method === "GET") return r.send(200, { ok: true }), true;
    },
    // No session: /api/public/..., /api/guest/... and /api/hooks/... only.
    // /api/hooks/ skips the browser origin check, so verify a signature or token.
    async guest(r) {},
    // Runs for every owner request before routing; throw AppError(…, 403) to refuse.
    async authorize(r) {},
  },
  // Background work. Never overlaps itself. Runs as actor "job:<module>:<name>".
  jobs: [{ name: "sweep", every: 3600000, delay: 15000, async run(ctx) { return { done: 0 }; } }],
  // Added to GET /api/workspace as S.ext.<name>. Read documents with
  // store.documents() / store.document(id): during the load they are worked
  // out once for every module (store.cachedReads). Hydrating rows yourself
  // repeats that work for each document.
  workspace(r) { return {}; },
  // Added to the client document JSON as d.ext.<name>. Client-safe data only.
  publicDocument(d, r) { return {}; },
  // Extra <head> tags for browser pages (e.g. link previews for /client/<token>).
  pageHead(r) { return ""; },
  // Added to the JSON business export as ext.<name>. No secrets or file bytes.
  exportData(store) { return {}; },
  // Routes staff and accountants may use (server/ext/team.mjs). Unlisted owner
  // routes are refused for them, so new routes stay owner-only by default.
  access: { staff: [["POST", /^\/api\/example$/]], accountant: [["GET", /^\/api\/example$/]] },
  // Called on a restored copy of the database: revoke links, tokens, outgoing jobs.
  onRestore(db) {},
  // Demo workspace records.
  seedDemo(store) {},
};
```

The request object `r`: `{ req, res, url, path, method, ip, body(), rawBody(limit), send(status, data, headers), sendFile(file, url), allow(key, max, ms), ctx, session, write(scope, payload, fn) }`. `body()` parses JSON (128 KB). `write()` makes a request idempotent with the `Idempotency-Key` header. `allow()` is the rate limiter.

### Shared services

- **Recently deleted** (`server/trash.mjs`): a module that adds a user-facing delete registers it in `TRACKED` (Store method, table, how it is named and where it opens). The delete then keeps a 30-day copy of the record, the rows that point at it and its files, and the browser shows Undo. Internal clean-up (replacing a logo, expiring scans) keeps calling the plain delete and keeps no copy. `trash` is the last module so its wrappers sit outside every other module's.
- **Files** (`server/files.mjs`): `store.saveFile({ entity_type, entity_id, purpose, name, data, visibility }, { accept, maxBytes })`, `store.files(type, id, purpose)`, `store.file(id)`, `store.deleteFile(id)`, `store.deleteFilesFor(recordId)` (call it when your module deletes a record; core deletes already do). Types are sniffed from content (PNG, JPEG, WEBP, GIF, PDF), 5 MB by default. Owner routes: `POST /api/files?entity_type=&entity_id=&purpose=&name=&visibility=` (raw body), `GET /api/files?…`, `GET /api/files/:id`, `DELETE /api/files/:id`. Serve client-visible files from your own guest route with `r.sendFile(file, r.url)` after checking the client's token.
- **Settings keys** (`server/secrets.mjs`): `store.config(NAME)`, `store.secret(NAME)`, `store.setSecret(NAME, value)`. Declared keys appear in Settings automatically.
- **Events**: every audit entry is an event. `store.auditSince(consumer, limit)` returns new entries for that consumer (a new consumer starts at the latest entry); `store.ackAudit(consumer, lastId)` moves its cursor. Audit `action` names include `document.issued`, `quotation.accepted`, `receipt.received`, `payment.allocated`, `online_payment.paid`, `payment.reference.submitted`, `document.viewed`, `document.voided`, `email.sent`.
- **Automation events**: `store.emit(type, entity_id, payload)` feeds the automation rules (`server/sales.mjs`).
- **PDF blocks**: wrap `Store.prototype.pdfBlocks` (async) and append `{ heading, text, qr, qrSize, image, imageWidth, imageHeight }`. Blocks print after the notes. Keep the original call.
- **QR codes** (`server/qr.mjs`): `qrSvg(text)`, `qrDataUri(text)`, `drawQr(pdf, text, x, y, size)`.
- **Proposals**: `store.propose(kind, data, source, request_key)` queues an action for owner approval. Add your own types in `attach()` with `registerProposalKind(kind, { schema (zod), validate(store, b), apply(store, b) → { kind, id }, summary(b) })` from `server/automation.mjs`; `apply` runs inside the approval transaction.
- **Client documents by ID** (portal module): `store.portalDocument(clientId, docId)`, and `portalRef(clientId, docId)` from `server/portal-access.mjs` can be passed wherever a client-link token is accepted (`publicDocument`, `accept`, `proof`, `gateway.checkout`). `safeDoc(d)` from `server/app.mjs` gives the client-safe document fields. `ctx.services.portal.recipients(clientId)` returns `{ to, cc }` from the client's contacts.
- **Mail**: `ctx.mailer.deliver({ kind, to, cc, subject, body, attachments, documentId, clientId, dedupeKey })` (`kind` is any short label, e.g. `notification`).
- **Test fixture** (`test/helpers.mjs`): `fixture()` gives a signed-in server (`auth`, `json`, `request`), `issuedInvoice(store)`, `PNG_1PX`.

## Browser module

```js
// public/ext/example.mjs
export default function exampleUI(h) {
  return {
    // module: hide the entry while that optional module is off (Settings > Modules).
    nav: [{ key: "things", label: "Things", icon: "box", group: "Operations", module: "ops" }],
    pages: { things: (id) => h.heading("Things", "…") + "…" },
    activeFor: { thing: "things" },          // detail page → highlighted nav entry
    icons: { gear: '<path d="…"/>' },        // extra 24px stroke icons
    async action(type, id, el) { /* return true when handled */ },
    async submit(form, b) { /* return true when handled */ },
    async guestPage(location) { /* render a page without sign-in; return true */ },
    can(kind, name) { /* "nav" | "page" | "action": return false to hide (e.g. by role) */ },
    // Start values of the document/statement email form; return the fields to change.
    emailPrefill(kind, record, values) { return { cc: "copy@example.com" }; },
    slots: {
      login: () => "",                       // under the sign-in form (e.g. "Forgot password?")
      topbar: () => "",                      // small items in the top bar (e.g. a bell)
      overviewTop: () => "",                 // a panel at the top of the overview (the setup checklist)
      overview: () => "",                    // panels on the overview page
      documentActions: (d) => "",            // buttons on a document
      documentPanels: (d) => "",             // side panels on a document
      documentFields: (value, kind) => "",   // fields in the document editor
      paper: (d, publicView) => "",          // extra sections on the document paper
      clientFields: (c) => "",               // fields in the client form
      clientDetails: (c) => "",              // <dt>/<dd> rows on the client profile
      clientActions: (c) => "",              // buttons on the client profile
      clientPanels: (c) => "",               // panels under the client profile
      settings: () => "",                    // panels on the Settings page
      publicPanels: (d, token) => "",        // panels on the client document page
      emailFields: (kind, record) => "",     // fields in the document/statement email form
    },
  };
}
```

`h` provides: `get()` (workspace state `S`, module data in `S.ext.<name>`), `session()`, `api(path, method, body)`, `upload(file, params)`, `refresh()`, `renderRoute()`, `navigate(route)`, `showModal(title, html, wide)`, `modal`, `toast(msg, error)`, `confirmModal`, `reasonForm`, `E` (escape), `money`, `dec`, `dateLabel`, `timeLabel`, `addDays`, `button`, `badge`, `input`, `formValues(form)`, `dateValue(el)`, `setDateValue(el, iso)`, `area`, `select`, `formEnd`, `errorBlock`, `heading`, `empty`, `icon`, `icons`, `paged`, `invoiceTable`, `clientOptions`, `slot`, `paper(d, publicView)` (the document paper), `logo()`.

Date fields: `input(label, name, value, "date")` renders a dd/mm/yyyy text field with a calendar button; the record value stays ISO. Read a form with `formValues(form)` (not `new FormData`) and a single field with `dateValue(el)`; write one with `setDateValue(el, iso)`.

Named form fields added through `clientFields` and `documentFields` are sent with the core save request (checkboxes arrive as `"on"`). Plugins see actions and form submits before the core does, so a module can take over a core action by handling its name.

Escape every value with `h.E`. The Content Security Policy blocks inline scripts and styles: attach listeners in `action`/`submit` or after `showModal`, and put styles in the module stylesheet.

## Rules

- Money is integer sen (minor units). Never use floats for stored amounts.
- Financial writes run in `store.tx()`. Issued documents, receipts and audit entries are never edited or deleted.
- Anything that sends, charges or issues automatically must be opt-in, logged and at most once (use a dedupe key).
- Owner-only data never reaches client links. Guest routes check the token and rate-limit with `r.allow`.
- No new npm dependency without a strong reason; use `fetch` for HTTP APIs.
- Tests in `test/<name>*.test.mjs`. Run `npm run check && npm test`.
- Describe the module for owners in `docs/features/<name>.md`.
