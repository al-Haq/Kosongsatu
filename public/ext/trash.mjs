// Recently deleted: restore what was deleted in the last 30 days.
// Feature module contract: see docs/PLUGINS.md. Owner guide: docs/features/trash.md.
import { errorHtml } from "./error-tips.mjs";
export default function trashUI(h) {
  const { E, button, empty, heading, timeLabel, dateLabel, modal } = h;
  const T = () => h.get().ext?.trash || { days: 30, items: [], purge: false };
  const daysLeft = (iso) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

  function page() {
    const t = T();
    const items = t.items || [];
    const rows = items
      .map((x) => {
        const left = daysLeft(x.expires);
        const files = x.files ? ` · ${x.files} file${x.files > 1 ? "s" : ""}, ${size(x.bytes)}` : "";
        return `<tr><td class="card-title"><strong>${E(x.label)}</strong><small>${E(x.what)}${E(files)}</small></td><td data-label="Deleted">${timeLabel(x.deleted)}<small>${E(x.deleted_by === "system" ? "Automatic" : x.deleted_by)}</small></td><td data-label="Kept until">${dateLabel(x.expires.slice(0, 10))}<small>${left ? `${left} day${left > 1 ? "s" : ""} left` : "Today"}</small></td><td class="bin-actions"><div class="actions">${button("Restore", "bin-restore", x.id, true)}${t.purge ? button("Delete for good", "bin-purge", x.id) : ""}</div></td></tr>`;
      })
      .join("");
    const list = items.length
      ? `<section class="panel"><div class="table-wrap"><table class="table-cards bin-table"><caption class="sr-only">Recently deleted</caption><thead><tr><th>Item</th><th>Deleted</th><th>Kept until</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div></section>`
      : `<section class="panel">${empty("Nothing deleted", `Drafts, clients, services, files and other records you delete stay here for ${t.days} days so you can restore them.`)}</section>`;
    return (
      heading("Recently deleted", `Deleted items stay here for ${t.days} days, then they are removed for good.`) +
      list +
      `<p class="field-hint mt22">Issued invoices, quotations, receipts and payments are never deleted, so they never land here: void a document or reverse a payment instead, and both stay in the history.</p>`
    );
  }

  async function restore(id, fromUndo) {
    const r = await h.api(`/trash/${encodeURIComponent(id)}/restore`, "POST");
    if (modal.open) modal.close();
    await h.refresh();
    // Undo goes back to the record when it has its own page.
    if (fromUndo && r.link && location.hash !== "#/" + r.link) h.navigate(r.link);
    else h.renderRoute();
    h.toast(`${r.what} restored.${r.note ? " " + r.note : ""}`);
  }

  return {
    nav: [{ key: "deleted", label: "Recently deleted", icon: "trash", group: "Workspace" }],
    pages: { deleted: page },
    icons: {
      trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3"/>',
    },
    async action(type, id) {
      switch (type) {
        case "bin-undo":
          await restore(id, true);
          return true;
        case "bin-restore":
          await restore(id, false);
          return true;
        case "bin-purge":
          h.confirmModal(
            "Delete for good?",
            "This copy is removed now and cannot be restored. The audit trail keeps a record that it was deleted.",
            "bin-purge-confirm",
            id,
            "Delete for good",
          );
          return true;
        case "bin-purge-confirm":
          try {
            await h.api(`/trash/${encodeURIComponent(id)}`, "DELETE");
          } catch (e) {
            modal.querySelector(".form-error").innerHTML = errorHtml(e);
            return true;
          }
          modal.close();
          await h.refresh();
          h.renderRoute();
          h.toast("Deleted for good.");
          return true;
      }
      return false;
    },
  };
}
