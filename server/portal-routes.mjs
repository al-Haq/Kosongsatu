// HTTP routes of the portal module: owner screens under /api/portal/ and
// client-facing routes under /api/guest/portal/ (no owner session).
import { renderPdf, renderReceiptPdf, renderAdjustmentPdf } from "./pdf.mjs";
import { renderStatementPdf } from "./statement.mjs";
import { requestContext } from "./context.mjs";
import { check, hash, AppError } from "./domain.mjs";
import { portalRef, sameSecret, SESSION_HOURS, SIGNIN_MINUTES, INVITE_HOURS } from "./portal-access.mjs";

export const COOKIE = "nawlogic_portal";
const BASE = "/api/guest/portal";
export const portalCookie = (token, secure, clear = false) =>
  `${COOKIE}=${clear ? "" : token}; Path=${BASE}; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`;
const readCookie = (req) =>
  (req.headers.cookie || "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(COOKIE + "="))
    ?.slice(COOKIE.length + 1);
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[\s]*[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
const pdf = (r, bytes, name) =>
  r.send(200, bytes, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${String(name).replace(/[^\w.-]/g, "_")}.pdf"`,
  });
const safe = async (d) => (await import("./app.mjs")).safeDoc(d);
// Client-safe extras from every module, as on the client link page.
async function documentExtras(d, r) {
  const { PLUGINS } = await import("./plugins.mjs");
  const out = {};
  for (const p of PLUGINS.filter((x) => x.publicDocument)) {
    try {
      out[p.name] = await p.publicDocument(d, r);
    } catch {
      out[p.name] = null;
    }
  }
  return out;
}
const onlinePayment = (r, d) =>
  r.ctx.gateway.status().configured &&
  d.kind === "invoice" &&
  d.state === "issued" &&
  d.balance > 0 &&
  !!(d.client.email || d.client.phone || r.ctx.store.settings().email);

// Sign-in emails go out after the response, so the answer and its timing are
// the same whether or not the address has portal access.
export function sendSigninLinks(ctx, links, track) {
  if (!links.length) return;
  const company = ctx.store.settings().company;
  const job = ctx.mailer
    .deliver({
      kind: "portal",
      clientId: links[0].client.id,
      to: [links[0].contact.email],
      subject: `Sign in to the ${company} client portal`,
      body: [
        `Hello ${links[0].contact.name || ""},`.replace(" ,", ","),
        "",
        `Use the link below to sign in to the ${company} client portal. Each link works once and expires in ${SIGNIN_MINUTES} minutes.`,
        "",
        ...links.map((l) => `${links.length > 1 ? l.client.name + ": " : ""}${ctx.appUrl}/portal/login/${l.token}`),
        "",
        "If you did not ask to sign in, you can ignore this email. Nobody can sign in without the link.",
        "",
        company,
      ].join("\n"),
    })
    .catch(() => console.error("Portal sign-in email could not be sent; see the email log."));
  track(job);
}

export async function guestRoutes(r, track) {
  if (!r.path.startsWith(BASE + "/")) return false;
  const { store, mailer, gateway, appUrl, secure } = r.ctx;
  const sub = r.path.slice(BASE.length);
  const context = requestContext.getStore();
  context.actor = "client-portal";
  r.allow("portal:" + r.ip, 120, 60000);
  const GET = r.method === "GET",
    POST = r.method === "POST";

  // ---- No session needed -------------------------------------------------
  if (sub === "/config" && GET) {
    const b = store.settings();
    return r.send(200, { company: b.company, email: b.email, phone: b.phone, email_signin: mailer.status().configured }), true;
  }
  if (sub === "/signin" && POST) {
    r.allow("portal-signin:" + r.ip, 5, 15 * 60000);
    const b = await r.body();
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase().slice(0, 160) : "";
    let links = [];
    try {
      r.allow("portal-signin-email:" + hash(email), 3, 15 * 60000);
      if (mailer.status().configured) links = store.portalSigninRequest(email);
    } catch (e) {
      // A busy address is skipped quietly; saying so would confirm it exists.
      if (!(e instanceof AppError && e.status === 429)) throw e;
    }
    sendSigninLinks(r.ctx, links, track);
    return (
      r.send(202, {
        ok: true,
        message: `If this email has portal access, a sign-in link is on its way. It works once, for ${SIGNIN_MINUTES} minutes.`,
      }),
      true
    );
  }
  if ((sub === "/verify" || sub === "/access") && POST) {
    r.allow("portal-verify:" + r.ip, 20, 15 * 60000);
    const b = await r.body();
    const s = sub === "/verify" ? store.portalVerify(b.token) : store.portalLinkSignin(b.token);
    return r.send(200, { csrf: s.csrf }, { "Set-Cookie": portalCookie(s.token, secure) }), true;
  }
  // Client-link pages (/client/<token>): signing and feedback without an account.
  const link = sub.match(/^\/link\/([\w-]{43})\/(accept|signature|feedback)$/);
  if (link) {
    const [, token, action] = link;
    context.actor = "client-link";
    r.allow("public:" + r.ip, 120, 60000);
    if (action === "signature" && GET) {
      const d = store.publicDocument(token);
      const s = store.signature(d.id);
      check(s, "Signature not found.", 404);
      return r.sendFile(store.file(s.file_id), r.url), true;
    }
    if (action === "accept" && POST) {
      r.allow("submit:" + r.ip, 12, 60000);
      const out = store.signQuote(token, await r.body(), {
        ip: r.ip,
        userAgent: r.req.headers["user-agent"],
        source: "link",
      });
      return r.send(200, await safe(out.document)), true;
    }
    if (action === "feedback" && POST) {
      r.allow("submit:" + r.ip, 12, 60000);
      const d = store.publicDocument(token);
      return r.send(201, { ok: true, rating: store.submitFeedback(d.id, await r.body(), "link").rating }), true;
    }
    throw new AppError("Not found.", 404);
  }
  // Emailed feedback requests (/portal/feedback/<token>).
  const fb = sub.match(/^\/feedback\/([\w-]{43})$/);
  if (fb) {
    context.actor = "client-feedback";
    r.allow("feedback:" + r.ip, 30, 60000);
    const d = store.feedbackByToken(fb[1]);
    if (GET)
      return (
        r.send(200, {
          number: d.number,
          client: d.client.name,
          company: d.business.company,
          total: d.adjusted_total ?? d.total,
          currency: d.currency || "MYR",
          feedback: store.publicFeedback(d),
        }),
        true
      );
    if (POST) {
      r.allow("submit:" + r.ip, 12, 60000);
      return r.send(201, { ok: true, rating: store.submitFeedback(d.id, await r.body(), "email").rating }), true;
    }
    throw new AppError("Not found.", 404);
  }

  // ---- Signed-in client ----------------------------------------------------
  const session = store.portalSession(readCookie(r.req));
  check(session, "Please sign in to the client portal.", 401);
  const cid = session.client_id;
  context.actor = session.contact ? "portal:" + session.contact.email : "portal-link:" + String(session.link_id).slice(0, 8);
  r.allow("portal-session:" + session.hash, 300, 60000);
  // Cookies are SameSite=Strict and the origin is checked; the token is a second lock.
  if (!GET)
    check(sameSecret(r.req.headers["x-portal-csrf"], session.csrf), "Session verification failed. Refresh and try again.", 403);
  if (sub === "/session" && GET) {
    const client = store.client(cid);
    return (
      r.send(200, {
        csrf: session.csrf,
        client: { name: client.name },
        contact: session.contact ? { name: session.contact.name, email: session.contact.email } : null,
        expires: session.expires,
      }),
      true
    );
  }
  if (sub === "/signout" && POST) {
    store.endPortalSession(session.hash);
    return r.send(200, { ok: true }, { "Set-Cookie": portalCookie("", secure, true) }), true;
  }
  if (sub === "/overview" && GET) return r.send(200, store.portalOverview(cid)), true;
  if (sub === "/statement.pdf" && GET) {
    const s = store.statement(cid, {
      from_date: r.url.searchParams.get("from") || undefined,
      to_date: r.url.searchParams.get("to") || undefined,
    });
    return pdf(r, await renderStatementPdf(s), `statement-${s.to}`), true;
  }
  const receipt = sub.match(/^\/receipts\/([\w-]{1,80})\/pdf$/);
  if (receipt && GET) {
    const rc = store.portalReceipt(cid, receipt[1]);
    return pdf(r, await renderReceiptPdf(rc), rc.number), true;
  }
  const note = sub.match(/^\/notes\/([\w-]{1,80})\/pdf$/);
  if (note && GET) {
    const { note: row, invoice } = store.portalNote(cid, note[1]);
    return pdf(r, await renderAdjustmentPdf(invoice, row), row.number), true;
  }
  const doc = sub.match(/^\/documents\/([\w-]{1,80})(?:\/(pdf|signature|accept|payment-reference|checkout|payment-return|feedback))?$/);
  if (doc) {
    const [, docId, action] = doc;
    if (!action && GET) {
      const d = store.portalDocument(cid, docId, true);
      return (
        r.send(200, {
          ...(await safe(d)),
          online_payment: onlinePayment(r, d),
          ext: await documentExtras(d, r),
        }),
        true
      );
    }
    const d = store.portalDocument(cid, docId);
    if (action === "pdf" && GET) return pdf(r, await renderPdf(d, null, await store.pdfBlocks(d)), d.number), true;
    if (action === "signature" && GET) {
      const s = store.signature(d.id);
      check(s, "Signature not found.", 404);
      return r.sendFile(store.file(s.file_id), r.url), true;
    }
    if (POST) r.allow("submit:" + r.ip, 12, 60000);
    if (action === "accept" && POST) {
      const out = store.signQuote(portalRef(cid, d.id), await r.body(), {
        ip: r.ip,
        userAgent: r.req.headers["user-agent"],
        source: "portal",
        contactId: session.contact?.id || null,
      });
      return r.send(200, await safe(out.document)), true;
    }
    if (action === "payment-reference" && POST) return r.send(201, store.portalProof(cid, d.id, await r.body())), true;
    if (action === "feedback" && POST)
      return r.send(201, { ok: true, rating: store.submitFeedback(d.id, await r.body(), "portal").rating }), true;
    if (action === "checkout" && POST) {
      r.allow("checkout:" + r.ip, 10, 60000);
      return r.send(200, await gateway.checkout(portalRef(cid, d.id), appUrl, `${appUrl}/portal/d/${d.id}`)), true;
    }
    if (action === "payment-return" && POST) {
      const b = await r.body();
      const params = Object.fromEntries(
        Object.entries(b.params || {})
          .filter(([k, v]) => /^billplz\[[a-z_]+\]$/.test(k) && typeof v === "string")
          .slice(0, 10),
      );
      const { id: billId, paidAt } = gateway.verify(params);
      check(
        store.db.prepare("SELECT 1 FROM online_payments WHERE bill_id=? AND invoice_id=?").get(billId, d.id),
        "Payment not found.",
        404,
      );
      return r.send(200, { state: (await gateway.settle(billId, paidAt)).state }), true;
    }
  }
  throw new AppError("Not found.", 404);
}

export async function ownerRoutes(r, track) {
  if (!r.path.startsWith("/api/portal/")) return false;
  const { store, mailer, appUrl } = r.ctx;
  const { path, method } = r;
  const m = (re) => path.match(re);
  let x;
  if ((x = m(/^\/api\/portal\/clients\/([\w-]+)$/)) && method === "GET") {
    store.client(x[1]);
    return (
      r.send(200, {
        account: store.portalAccount(x[1]),
        contacts: store.contacts(x[1]),
        credit: store.creditStatus(x[1]),
        recipients: store.clientRecipients(x[1]),
      }),
      true
    );
  }
  if ((x = m(/^\/api\/portal\/clients\/([\w-]+)\/portal$/)) && method === "PUT")
    return r.send(200, store.setPortalEnabled(x[1], (await r.body()).enabled)), true;
  if ((x = m(/^\/api\/portal\/clients\/([\w-]+)\/credit$/)) && method === "PUT") {
    store.saveCreditSettings(x[1], { portal_credit: "1", ...(await r.body()) });
    return r.send(200, store.creditStatus(x[1])), true;
  }
  if ((x = m(/^\/api\/portal\/clients\/([\w-]+)\/recipients$/)) && method === "GET")
    return r.send(200, store.clientRecipients(x[1])), true;
  if ((x = m(/^\/api\/portal\/clients\/([\w-]+)\/invite$/)) && method === "POST") {
    r.allow("portal-invite:" + r.session.owner_id, 30, 600000);
    const b = await r.body();
    const out = store.portalInvite(x[1], String(b.contact_id || ""));
    const url = `${appUrl}/portal/login/${out.token}`;
    if (b.copy === true || !mailer.status().configured)
      return r.send(201, { url, expires: out.expires, email: out.contact.email, sent: false }), true;
    const company = store.settings().company;
    try {
      await mailer.deliver({
        kind: "portal",
        clientId: x[1],
        to: [out.contact.email],
        subject: `Your ${company} client portal`,
        body: [
          `Hello ${out.contact.name || out.client.name},`,
          "",
          `${company} has opened a client portal for ${out.client.name}. You can see your invoices, quotations, receipts and statements, pay or send a payment reference, and accept quotations.`,
          "",
          `Open the portal (this link works once, within ${INVITE_HOURS / 24} days):`,
          url,
          "",
          `Next time, sign in at ${appUrl}/portal/signin with this email address and we'll send you a new link.`,
          "",
          company,
        ].join("\n"),
      });
    } catch (e) {
      store.db.prepare("DELETE FROM portal_login_tokens WHERE token_hash=?").run(hash(out.token));
      throw e;
    }
    return r.send(201, { sent: true, email: out.contact.email, expires: out.expires }), true;
  }
  if ((x = m(/^\/api\/portal\/clients\/([\w-]+)\/links$/)) && method === "POST") {
    const out = store.createPortalLink(x[1], await r.body());
    return r.send(201, { id: out.id, url: `${appUrl}/portal/access/${out.token}`, expires: out.expires }), true;
  }
  if ((x = m(/^\/api\/portal\/links\/([\w-]+)\/revoke$/)) && method === "POST")
    return r.send(200, store.revokePortalLink(x[1])), true;
  if ((x = m(/^\/api\/portal\/clients\/([\w-]+)\/sessions\/revoke$/)) && method === "POST")
    return r.send(200, store.revokePortalSessions(x[1])), true;
  if ((x = m(/^\/api\/portal\/clients\/([\w-]+)\/contacts$/)) && method === "POST") {
    const b = await r.body();
    return r.send(201, r.write("portal.contact:" + x[1], b, () => store.saveContact(x[1], b))), true;
  }
  if ((x = m(/^\/api\/portal\/contacts\/([\w-]+)$/))) {
    if (method === "PUT") {
      const c = store.contact(x[1]);
      return r.send(200, store.saveContact(c.client_id, await r.body(), c.id)), true;
    }
    if (method === "DELETE") return store.deleteContact(x[1]), r.send(200, { ok: true }), true;
  }
  if ((x = m(/^\/api\/portal\/documents\/([\w-]+)\/credit$/)) && method === "GET") {
    const { message, blocked, reasons, projected, amount, override } = store.creditCheck(store.document(x[1]));
    return r.send(200, { blocked, reasons, message, projected, amount, override }), true;
  }
  if ((x = m(/^\/api\/portal\/documents\/([\w-]+)\/credit-override$/)) && method === "POST")
    return r.send(201, store.allowCreditOverride(x[1], (await r.body()).reason)), true;
  if (path === "/api/portal/feedback" && method === "GET")
    return r.send(200, { summary: store.feedbackSummary(), items: store.feedbackList() }), true;
  if ((x = m(/^\/api\/portal\/feedback\/([\w-]+)$/)) && method === "PUT")
    return r.send(200, store.setTestimonial(x[1], (await r.body()).testimonial)), true;
  if (path === "/api/portal/feedback.csv" && method === "GET") {
    const only = r.url.searchParams.get("testimonials") === "1";
    const rows = store.feedbackList({ testimonials: only, limit: 100000 });
    const lines = [
      ["Date", "Client", "Invoice", "Rating", "Comment", "Show as", "Testimonial allowed", "Testimonial", "Source"],
      ...rows.map((f) => [
        f.created.slice(0, 10),
        f.client_name,
        f.invoice_number,
        f.rating,
        f.comment,
        f.display_name,
        f.consent ? "Yes" : "No",
        f.testimonial ? "Yes" : "No",
        f.source,
      ]),
    ];
    return (
      r.send(200, "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n"), {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${only ? "testimonials" : "client-feedback"}.csv"`,
      }),
      true
    );
  }
  if (path === "/api/portal/settings" && method === "PUT") {
    const b = await r.body();
    check(!b.feedback_emails || mailer.status().configured, "Set up email before turning on feedback requests.", 409);
    return r.send(200, store.savePortalSettings(b)), true;
  }
  return false;
}
