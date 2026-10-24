// Setup: the first-run checklist, optional modules on/off and the business's own name and logo on the sign-in page.
// Feature module contract: see docs/PLUGINS.md.
import { AppError, check, now } from "../domain.mjs";
import { MODULE_KEYS, ownCompany } from "../../public/ext/setup-modules.mjs";

// Checklist steps that are optional, so the owner may mark them as not needed.
const SKIPPABLE = ["sst", "gateway"];
const LOGO_TYPES = ["image/png", "image/jpeg"];
const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

export default {
  name: "setup",
  attach(Store) {
    Object.assign(Store.prototype, {
      // Saves which optional modules are off and the checklist state, in Settings.
      // { modules: { books: false }, dismissed: true, skipped: { sst: true } }
      saveSetup(b) {
        check(plainObject(b), "Invalid request.");
        check(["modules", "dismissed", "skipped"].some((k) => k in b), "Nothing to change.");
        return this.tx(() => {
          const s = this.settings();
          const modules = { ...(s.modules || {}) };
          if ("modules" in b) {
            check(plainObject(b.modules), "Choose which modules to show.");
            for (const [key, on] of Object.entries(b.modules)) {
              check(MODULE_KEYS.includes(key), "That module cannot be turned off.");
              check(typeof on === "boolean", "Turn a module on or off.");
              // Only "off" is stored: anything not listed is on.
              if (on) delete modules[key];
              else modules[key] = false;
            }
          }
          const setup = { dismissed: s.setup?.dismissed || null, skipped: [...(s.setup?.skipped || [])] };
          if ("dismissed" in b) {
            check(typeof b.dismissed === "boolean", "Choose whether to hide the checklist.");
            setup.dismissed = b.dismissed ? setup.dismissed || now() : null;
          }
          if ("skipped" in b) {
            check(plainObject(b.skipped), "Choose which steps to skip.");
            for (const [step, skip] of Object.entries(b.skipped)) {
              check(SKIPPABLE.includes(step), "Only optional steps can be skipped.");
              check(typeof skip === "boolean", "Choose whether to skip the step.");
              setup.skipped = setup.skipped.filter((x) => x !== step);
              if (skip) setup.skipped.push(step);
            }
          }
          const before = { modules: s.modules || {}, setup: s.setup || { dismissed: null, skipped: [] } };
          this.db.prepare("UPDATE settings SET data=? WHERE id=1").run(JSON.stringify({ ...s, modules, setup }));
          if (JSON.stringify(before.modules) !== JSON.stringify(modules)) {
            const off = Object.keys(modules);
            this.audit("settings.modules.changed", null, off.length ? "Turned off: " + off.join(", ") : "All modules on", before.modules, modules);
          }
          if (JSON.stringify(before.setup) !== JSON.stringify(setup))
            this.audit("settings.setup.changed", null, setup.dismissed ? "Setup checklist hidden" : "Setup checklist", before.setup, setup);
          return { modules, setup };
        });
      },
      // The business logo from Settings > Documents, if it is a usable image.
      brandLogo() {
        const fid = this.settings().logoFileId;
        if (!fid) return null;
        const f = this.db
          .prepare("SELECT id,mime,data FROM files WHERE id=? AND entity_type='business' AND purpose='logo'")
          .get(fid);
        return f && LOGO_TYPES.includes(f.mime) ? { ...f, data: Buffer.from(f.data) } : null;
      },
      // What the sign-in page may show before anyone signs in: the business name
      // (once it is the business's own) and whether there is a logo. Nothing else.
      branding() {
        const logo = this.brandLogo();
        return {
          company: ownCompany(this.settings()) || null,
          // The query only changes when the logo does, so the browser shows the new one.
          logo: logo ? `/api/guest/setup/logo?v=${logo.id.slice(0, 8)}` : null,
        };
      },
    });
  },
  routes: {
    async owner(r) {
      if (r.path !== "/api/ext/setup" || r.method !== "PUT") return false;
      // Team rules already refuse staff and accountants; this keeps it owner-only on its own.
      check(r.session.role === "owner", "Only the workspace owner can change this.", 403);
      r.send(200, r.ctx.store.saveSetup(await r.body()));
      return true;
    },
    // Signed out: the sign-in page's name and logo. The logo is the only file served here.
    async guest(r) {
      if (!r.path.startsWith("/api/guest/setup/")) return false;
      check(r.method === "GET", "Not found.", 404);
      r.allow("setup-brand:" + r.ip, 120, 60000);
      const { store } = r.ctx;
      if (r.path === "/api/guest/setup/branding") {
        r.send(200, store.branding());
        return true;
      }
      if (r.path === "/api/guest/setup/logo") {
        const f = store.brandLogo();
        check(f, "Not found.", 404);
        r.sendFile({ name: "logo." + (f.mime === "image/png" ? "png" : "jpg"), mime: f.mime, data: f.data }, r.url);
        return true;
      }
      throw new AppError("Not found.", 404);
    },
  },
};
