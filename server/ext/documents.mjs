// Documents and billing: line discounts, item codes, PDF templates, proforma, sales and delivery orders, currencies, languages, custom fields, deposits and instalments.
// Feature module contract: see docs/PLUGINS.md.
import { check, today, addDays, CURRENCIES, LANGUAGES } from "../domain.mjs";
import { DOCUMENT_MIGRATIONS } from "../documents-migrations.mjs";
import { attachDocuments, documentSettings, fieldApplies, LAYOUTS } from "../documents-store.mjs";
import { seedDocumentsDemo } from "../documents-demo.mjs";

const ID = "[\\w-]{1,80}";
const route = (path, pattern) => path.match(new RegExp("^/api/ext/documents/" + pattern + "$"));

// Custom field values a client may see: the issued snapshot's definitions,
// fields marked for the PDF only.
export function visibleCustomFields(d, includeInternal = false) {
  const defs = documentSettings(d.business).customFields || [];
  return defs
    .filter((f) => fieldApplies(f, d.kind) && d.meta?.custom?.[f.id] && (includeInternal || f.show === "pdf"))
    .map((f) => ({ id: f.id, label: f.label, value: d.meta.custom[f.id], internal: f.show !== "pdf" }));
}

export default {
  name: "documents",
  // Staff convert documents, create deposit invoices, set instalments and
  // manage attachments; the business logo stays with the owner.
  access: {
    staff: [
      ["POST", /^\/api\/ext\/documents\/[\w-]+\/(convert|deposit-invoice|attachments)$/],
      ["PUT", /^\/api\/ext\/documents\/[\w-]+\/instalments$/],
      ["DELETE", /^\/api\/ext\/documents\/[\w-]+\/instalments$/],
      ["PUT", /^\/api\/ext\/documents\/attachments\/[\w-]+$/],
      ["DELETE", /^\/api\/ext\/documents\/attachments\/[\w-]+$/],
    ],
  },
  migrations: DOCUMENT_MIGRATIONS,
  secrets: [
    {
      name: "PDF_CJK_FONT",
      label: "Chinese PDF font file",
      help: "Full path on the server to a .ttc, .otf or .ttf font with Chinese characters, e.g. /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc. Leave empty to search the usual system folders.",
      secret: false,
    },
  ],
  attach(Store) {
    attachDocuments(Store);
  },
  init(ctx) {
    // Billplz collects MYR only, so other currencies never get a payment page.
    const gateway = ctx.gateway;
    if (gateway?.checkout && !gateway.checkout.documentsCurrencyCheck) {
      const checkout = gateway.checkout.bind(gateway);
      gateway.checkout = async (token, origin, ...rest) => {
        const d = ctx.store.publicDocument(token);
        check((d.currency || "MYR") === "MYR", "Online payment is available for MYR invoices only.", 409);
        return checkout(token, origin, ...rest);
      };
      gateway.checkout.documentsCurrencyCheck = true;
    }
  },
  routes: {
    async owner(r) {
      if (!r.path.startsWith("/api/ext/documents/")) return false;
      const { store } = r.ctx;
      let m;
      if ((m = route(r.path, `(${ID})/convert`)) && r.method === "POST") {
        const b = await r.body();
        r.send(200, r.write("documents.convert:" + m[1], b, () => store.deriveDocument(m[1], b.to)));
        return true;
      }
      if ((m = route(r.path, `(${ID})/deposit-invoice`)) && r.method === "POST") {
        r.send(200, r.write("documents.deposit:" + m[1], {}, () => store.createDepositInvoice(m[1])));
        return true;
      }
      if ((m = route(r.path, `(${ID})/instalments`))) {
        if (r.method === "PUT") {
          const b = await r.body();
          r.send(200, store.setInstalments(m[1], b.instalments));
          return true;
        }
        if (r.method === "DELETE") {
          r.send(200, store.clearInstalments(m[1]));
          return true;
        }
      }
      if ((m = route(r.path, `(${ID})/attachments`)) && r.method === "POST") {
        r.allow("upload:" + r.session.owner_id, 60, 600000);
        const data = await r.rawBody();
        r.send(
          201,
          store.addAttachment(m[1], {
            name: r.url.searchParams.get("name") || "attachment",
            visibility: r.url.searchParams.get("visibility") || "private",
            data,
          }),
        );
        return true;
      }
      if ((m = route(r.path, `attachments/(${ID})`))) {
        if (r.method === "PUT") {
          r.send(200, store.setAttachmentVisibility(m[1], (await r.body()).visibility));
          return true;
        }
        if (r.method === "DELETE") {
          store.removeAttachment(m[1]);
          r.send(200, { ok: true });
          return true;
        }
      }
      if (r.path === "/api/ext/documents/logo") {
        if (r.method === "POST") {
          r.allow("upload:" + r.session.owner_id, 60, 600000);
          const data = await r.rawBody(1024 * 1024);
          r.send(201, store.setLogo({ name: r.url.searchParams.get("name") || "logo", data }));
          return true;
        }
        if (r.method === "DELETE") {
          store.clearLogo();
          r.send(200, { ok: true });
          return true;
        }
      }
      return false;
    },
    // Client links: the business logo and client-visible attachments.
    async guest(r) {
      const m = r.path.match(/^\/api\/guest\/documents\/([\w-]{43})\/(logo|files\/([\w-]{1,80}))$/);
      if (!m || r.method !== "GET") return false;
      r.allow("public:" + r.ip, 120, 60000);
      const { store } = r.ctx;
      if (m[2] === "logo") {
        const d = store.publicDocument(m[1]);
        const logo = store.logoFor(d.business);
        check(logo, "Not found.", 404);
        r.sendFile({ name: "logo." + (logo.mime === "image/png" ? "png" : "jpg"), mime: logo.mime, data: logo.data }, r.url);
        return true;
      }
      r.sendFile(store.publicAttachment(m[1], m[3]), r.url);
      return true;
    },
  },
  workspace(r) {
    const { store } = r.ctx;
    const font = store.cjkFont();
    return {
      cjkFont: !!font,
      cjkFontPath: font,
      currencies: CURRENCIES,
      languages: LANGUAGES,
      layouts: LAYOUTS,
      template: documentSettings(store.settings()),
    };
  },
  // Client-safe extras: PDF custom fields, client-visible attachments and the logo.
  publicDocument(d, r) {
    const s = documentSettings(d.business);
    return {
      custom: visibleCustomFields(d).map(({ label, value }) => ({ label, value })),
      attachments: (d.attachments || [])
        .filter((f) => f.visibility === "client")
        .map((f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime })),
      list_attachments: !!d.meta?.list_attachments,
      logo: !!r.ctx.store.logoFor(d.business),
      accent: s.pdfAccent,
      show: {
        bank: s.pdfShowBank,
        terms: s.pdfShowTerms,
        notes: s.pdfShowNotes,
        buyerTax: s.pdfShowBuyerTax,
      },
    };
  },
  exportData(store) {
    return {
      instalments: store.db.prepare("SELECT * FROM document_instalments ORDER BY invoice_id,seq").all(),
    };
  },
  seedDemo(store) {
    seedDocumentsDemo(store, { today, addDays });
  },
  jobs: [],
};
