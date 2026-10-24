// Autosave: what is typed into a workspace form is kept on this device until it
// is saved, so a crash, a power cut, a closed tab or a lost connection does not
// lose it. Opening the same form again brings the text back, with a Discard
// button; drafts whose form is not on screen are listed once after loading.
//
// Drafts live in this browser's localStorage, per signed-in user, and expire
// after 7 days. Saving the form, Cancel or signing out removes them. Password,
// code and key fields, file pickers, hidden fields and the sign-in, password,
// MFA and key forms are never kept.
const PREFIX = "nawlogic.draft:";
const REQUEST = "nawlogic.request:";
const TTL = 7 * 86400000;
const SAVE_DELAY = 400;
const SKIP_FORMS = new Set([
  "login",
  "password",
  "mfa-enable",
  "secret-save",
  "pay-keys",
  "connector-save",
  "team-password",
  "team-guest",
  "team-forgot",
  "team-reset-mfa",
  "team-backup-key",
  "team-key-saved",
  "team-check-head",
  "portal-signin",
  "assistant-chat",
]);
const SKIP_NAME = /pass|secret|token|otp|key|^code$|^confirm$/i;
// Controls with no name (rows of lines built by a module) can only be kept by a
// capture hook; the date fields' hidden pickers are not input.
const unnamedInput = (form) =>
  [...form.querySelectorAll("input, select, textarea")].some(
    (el) => !el.name && !el.disabled && el.getAttribute("aria-hidden") !== "true" && !["hidden", "file", "submit", "button", "reset", "image"].includes(el.type),
  );
const skipField = (el) =>
  ["password", "file", "hidden", "submit", "button", "reset", "image"].includes(el.type) ||
  el.autocomplete === "one-time-code" ||
  el.readOnly ||
  SKIP_NAME.test(el.name);

const storage = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k) || "null");
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
  keys(prefix = PREFIX) {
    try {
      return Object.keys(localStorage).filter((k) => k.startsWith(prefix));
    } catch {
      return [];
    }
  },
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const when = (t) =>
  new Intl.DateTimeFormat("en-MY", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }).format(new Date(t));

// user(): the signed-in email, or null on guest pages.
// extras[form]: { capture(form), restore(form, value) } for parts without names (invoice lines).
// canReopen(action) / reopen(opener): how a draft from a dialog is opened again.
export function createAutosave({ user, extras = {}, canReopen = () => false, reopen = async () => {} }) {
  const bases = new WeakMap(),
    openers = new WeakMap(),
    // The page each form is on, read when it appears: by the time a form is
    // saved on the way out, the address already shows the next page.
    routes = new WeakMap(),
    timers = new Map(),
    seen = new WeakSet(),
    // Drafts whose form is being saved right now: not restored into the page the
    // save renders (it shows the saved values), and dropped once the save succeeds.
    submitting = new Set(),
    // Request keys when nobody is signed in (not kept on the device).
    memory = new Map();
  let restoring = false,
    lastAction = null,
    pendingShown = false,
    // Kept after the session expires, so the last edits are still saved under this user.
    lastUser = null;

  const userPart = () => {
    const u = user() || lastUser;
    if (u) lastUser = u;
    return u ? encodeURIComponent(String(u).toLowerCase()) + ":" : null;
  };
  // A form's data- attributes say which record it belongs to (data-id, and the
  // parent: data-project, data-doc, data-client...), so they are all in the key
  // and a draft never opens under another record. Read once, as the form was
  // built: a request key added when it is sent must not move the draft.
  const contexts = new WeakMap();
  const contextOf = (form) => {
    if (!contexts.has(form))
      contexts.set(
        form,
        Object.entries(form.dataset)
          .filter(([k, v]) => v !== "" && !["form", "key", "requestKey"].includes(k))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => k + "=" + encodeURIComponent(v))
          .join("&"),
      );
    return contexts.get(form);
  };
  const keyOf = (form) => {
    const u = userPart();
    const name = form?.dataset?.form;
    if (!u || !name || SKIP_FORMS.has(name)) return null;
    return PREFIX + u + encodeURIComponent(name) + ":" + contextOf(form);
  };
  const fields = (form) => [...form.elements].filter((el) => el.name && !el.disabled && !skipField(el));
  // Which row a field is in: the data- attributes of the elements around it, up
  // to the form (a custom field row's data-field, a line's data-id...).
  const RUNTIME = new Set(["key", "requestKey", "booksW", "booksH", "booksBusy", "touched", "ink"]);
  // A form's own idempotency key (data-request-key, data-key). Kept with the
  // draft, so sending a restored draft again is not done twice when the first
  // send reached the server but its answer was lost.
  const SENT = ["requestKey", "key"];
  const sentKeys = (form) => Object.fromEntries(SENT.filter((k) => form.dataset[k]).map((k) => [k, form.dataset[k]]));
  const valueOf = (el) => (el.type === "checkbox" || el.type === "radio" ? el.checked : el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value);
  function rowOf(el, form) {
    const ids = [];
    for (let p = el.parentElement; p && p !== form; p = p.parentElement)
      for (const [k, v] of Object.entries(p.dataset)) if (!RUNTIME.has(k)) ids.push(k + "=" + v);
    return ids.join(",");
  }
  function snapshot(form) {
    const out = {},
      count = {},
      rows = [];
    for (const el of fields(form)) {
      const k = `${el.name}#${(count[el.name] = (count[el.name] ?? -1) + 1)}`;
      out[k] = valueOf(el);
      // A tick box or option names its record by its value (a time entry's id).
      rows.push(k + "@" + rowOf(el, form) + (el.type === "checkbox" || el.type === "radio" ? "=" + el.value : ""));
    }
    const snap = { fields: out, shape: rows.join("|"), sent: sentKeys(form) };
    const extra = extras[form.dataset.form]?.capture(form);
    if (extra !== undefined) snap.extra = extra;
    return snap;
  }
  const same = (a, b) => JSON.stringify(a.fields) === JSON.stringify(b.fields) && JSON.stringify(a.extra) === JSON.stringify(b.extra);
  // A draft is only kept when all of it can be put back: never half a form.
  // Without a hook, unnamed row controls cannot be kept, and a form whose rows
  // changed cannot be rebuilt: rows added or removed, or one removed and
  // another added in its place (the same fields, but not the same rows).
  const keepable = (form, snap, base) => !!extras[form.dataset.form] || (!unnamedInput(form) && (!base || snap.shape === base.shape));
  function apply(form, snap) {
    restoring = true;
    try {
      const count = {};
      for (const el of fields(form)) {
        const k = `${el.name}#${(count[el.name] = (count[el.name] ?? -1) + 1)}`;
        if (!(k in snap.fields)) continue;
        const v = snap.fields[k];
        // Only a field that changes is announced, as if typed: a module's
        // handlers (a language's template, a client's terms) do not run for
        // a field that already shows the kept value.
        if (JSON.stringify(valueOf(el)) === JSON.stringify(el.type === "checkbox" || el.type === "radio" ? !!v : v)) continue;
        if (el.type === "checkbox" || el.type === "radio") el.checked = !!v;
        else if (el.multiple) for (const o of el.options) o.selected = Array.isArray(v) && v.includes(o.value);
        else el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (snap.extra !== undefined) extras[form.dataset.form]?.restore(form, snap.extra);
      if (snap.sent) for (const k of SENT) snap.sent[k] ? (form.dataset[k] = snap.sent[k]) : delete form.dataset[k];
    } finally {
      restoring = false;
    }
  }
  function titleOf(form) {
    const dialog = form.closest("dialog");
    if (dialog) return dialog.querySelector(".modal-head h2")?.textContent.trim() || "Form";
    const page = document.querySelector("main h1")?.textContent.trim() || "";
    const section = form.closest(".panel")?.querySelector("h2")?.textContent.trim() || "";
    return [page, section].filter((x, i, a) => x && a.indexOf(x) === i).join(" · ") || "Form";
  }
  function save(form) {
    clearTimeout(timers.get(form));
    timers.delete(form);
    const key = keyOf(form);
    if (!key || !form.isConnected) return;
    const snap = snapshot(form);
    const base = bases.get(form);
    if ((base && same(base, snap)) || !keepable(form, snap, base)) return storage.del(key);
    storage.set(key, {
      v: 1,
      at: Date.now(),
      title: titleOf(form),
      route: routes.get(form) || location.hash || "#/",
      opener: openers.get(form) || null,
      ...snap,
    });
  }
  // The form now matches what is saved: forget the draft and start again from here.
  function settle(form) {
    clearTimeout(timers.get(form));
    timers.delete(form);
    const key = keyOf(form);
    if (key) storage.del(key);
    if (form.isConnected) bases.set(form, snapshot(form));
    form.querySelector(".autosave-notice")?.remove();
  }
  function notice(form, draft) {
    const box = document.createElement("div");
    box.className = "notice autosave-notice";
    box.setAttribute("role", "status");
    box.innerHTML = `<p>Restored what you typed on ${esc(when(draft.at))}. It is not saved yet.</p><button type="button" class="btn small" data-autosave-discard>Discard</button>`;
    form.prepend(box);
  }
  function attach(form) {
    const key = keyOf(form);
    if (!key) return;
    bases.set(form, snapshot(form));
    routes.set(form, location.hash || "#/");
    if (form.closest("dialog") && lastAction && Date.now() - lastAction.at < 3000) openers.set(form, { action: lastAction.action, id: lastAction.id, route: lastAction.route });
    const draft = storage.get(key);
    if (!draft || submitting.has(key)) return;
    if (Date.now() - draft.at > TTL || same(bases.get(form), draft) || !keepable(form, draft, bases.get(form))) return storage.del(key);
    if (draft.opener) openers.set(form, draft.opener);
    apply(form, draft);
    notice(form, draft);
    document.querySelector(`.autosave-pending [data-key="${CSS.escape(key)}"]`)?.remove();
  }
  function discover(node) {
    const forms = node.matches?.("form[data-form]") ? [node] : [...(node.querySelectorAll?.("form[data-form]") || [])];
    for (const f of forms)
      if (!seen.has(f)) {
        seen.add(f);
        attach(f);
      }
  }
  function flush() {
    for (const form of [...timers.keys()]) save(form);
  }
  function mine() {
    const u = userPart();
    if (!u) return [];
    const out = [];
    for (const key of storage.keys()) {
      if (!key.startsWith(PREFIX + u)) continue;
      const d = storage.get(key);
      if (!d || Date.now() - d.at > TTL) storage.del(key);
      else out.push({ key, ...d });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  // ---- Wiring ----
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) discover(n);
  }).observe(document.body, { childList: true, subtree: true });
  discover(document.body);
  const onEdit = (event) => {
    if (restoring) return;
    const form = event.target.closest?.("form[data-form]");
    if (!form || !keyOf(form) || (event.target.name && skipField(event.target))) return;
    clearTimeout(timers.get(form));
    timers.set(form, setTimeout(() => save(form), SAVE_DELAY));
  };
  document.addEventListener("input", onEdit);
  document.addEventListener("change", onEdit);
  // Invoice lines are added and removed with buttons, not typing. Listened to on
  // the way down (capture), before the app's own handler disables the button.
  document.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-action]");
    if (action) {
      lastAction = { action: action.dataset.action, id: action.dataset.id || "", route: location.hash || "#/", at: Date.now() };
      const form = action.closest("form[data-form]");
      if (form && keyOf(form)) setTimeout(() => onEdit({ target: form }), 0);
    }
    const discard = event.target.closest?.("[data-autosave-discard]");
    if (discard) {
      const form = discard.closest("form[data-form]");
      if (form) {
        const base = bases.get(form);
        if (base) apply(form, base);
        settle(form);
      }
    }
    const pending = event.target.closest?.("[data-autosave-pending]");
    if (pending) {
      const row = pending.closest("[data-key]");
      const d = storage.get(row.dataset.key);
      if (pending.dataset.autosavePending === "discard" || !d) {
        storage.del(row.dataset.key);
        row.remove();
      } else if (d.opener && canReopen(d.opener.action)) reopen(d.opener);
      else if (d.route) {
        if (location.hash === d.route) dispatchEvent(new HashChangeEvent("hashchange"));
        else location.hash = d.route.replace(/^#/, "");
      }
      const box = document.querySelector(".autosave-pending");
      if (box && !box.querySelector("[data-key]")) box.remove();
    }
  }, true);
  // Last chance before the page goes away (tab closed, phone locked, app switched).
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());

  // ---- Offline notice ----
  const banner = document.createElement("div");
  banner.id = "offline-banner";
  banner.setAttribute("role", "status");
  banner.textContent = "You are offline. What you type is kept on this device. Save again when you are back online.";
  const connection = () => {
    if (navigator.onLine) banner.remove();
    else if (!banner.isConnected) document.body.append(banner);
  };
  addEventListener("online", connection);
  addEventListener("offline", connection);
  connection();

  return {
    // The key a form's draft is kept under (null when it is never kept).
    keyOf,
    // Before a form is sent: keep its latest input, in case the save fails.
    submit(form) {
      const key = keyOf(form);
      if (!key) return null;
      save(form);
      submitting.add(key);
      return key;
    },
    // After the save succeeded.
    saved(form, key) {
      if (!key) return;
      submitting.delete(key);
      storage.del(key);
      if (form) settle(form);
    },
    // After the save failed: the draft stays for another try, with the request
    // key made while sending it.
    failed(form, key) {
      if (!key) return;
      submitting.delete(key);
      if (form?.isConnected && storage.get(key)) save(form);
    },
    // The idempotency key for a request (method, path and body), kept until it
    // is answered. Sending the same thing again, even after a reload or a power
    // cut, reuses it, so the server does it once.
    requestKey(id) {
      const u = userPart();
      if (!u) return (memory.has(id) || memory.set(id, crypto.randomUUID()), memory.get(id));
      const k = REQUEST + u + id,
        old = storage.get(k);
      if (old && Date.now() - old.at < TTL) return old.key;
      const key = crypto.randomUUID();
      storage.set(k, { key, at: Date.now() });
      return key;
    },
    // The server answered: the request is done, or was refused and can be sent anew.
    answered(id) {
      memory.delete(id);
      const u = userPart();
      if (u) storage.del(REQUEST + u + id);
    },
    // Cancel or Close on a dialog: the user chose not to keep what they typed.
    discardIn(root) {
      for (const form of root.querySelectorAll("form[data-form]")) settle(form);
    },
    // Before the page is rebuilt: save what was typed in the last moment.
    flush,
    // Signing out removes this user's drafts and kept request keys from the device.
    clearUser() {
      for (const d of mine()) storage.del(d.key);
      const u = userPart();
      if (u) for (const k of storage.keys(REQUEST + u)) storage.del(k);
      memory.clear();
      lastUser = null;
    },
    // Once per page load: drafts whose form is not on screen, with Open and Discard.
    showPending(container) {
      if (pendingShown || !container) return;
      pendingShown = true;
      const u = userPart();
      if (u) for (const k of storage.keys(REQUEST + u)) if (!(Date.now() - (storage.get(k)?.at || 0) < TTL)) storage.del(k);
      queueMicrotask(() => {
        const list = mine().filter((d) => !isOnScreen(d.key));
        if (!list.length) return;
        const box = document.createElement("div");
        box.className = "notice warn autosave-pending";
        box.setAttribute("role", "status");
        box.innerHTML = `<div><p><strong>Unsaved changes on this device</strong></p>${list
          .map(
            (d) =>
              `<div class="autosave-row" data-key="${esc(d.key)}"><span>${esc(d.title)} · ${esc(when(d.at))}</span><span class="actions">${(d.opener && canReopen(d.opener.action)) || (!d.opener && d.route) ? '<button type="button" class="btn small" data-autosave-pending="open">Open</button>' : '<small>Open the same form to continue.</small>'}<button type="button" class="btn small" data-autosave-pending="discard">Discard</button></span></div>`,
          )
          .join("")}</div>`;
        container.prepend(box);
      });
      const isOnScreen = (key) =>
        [...document.querySelectorAll("form[data-form]")].some((f) => keyOf(f) === key && f.querySelector(".autosave-notice"));
    },
  };
}
