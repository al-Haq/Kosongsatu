// Dates on screen are dd/mm/yyyy; the server and the records keep ISO (yyyy-mm-dd).
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY = /^(\d{1,2})\D(\d{1,2})\D(\d{4})$/;
// ISO -> dd/mm/yyyy. Anything else (empty, already dd/mm/yyyy) is returned as is.
export function dmy(iso) {
  const m = ISO.exec(String(iso || "").trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
}
// dd/mm/yyyy (or d/m/yyyy, dd-mm-yyyy) -> ISO. ISO passes through; other text is
// returned trimmed so the server can reject it with a clear message.
export function isoDate(text) {
  const s = String(text || "").trim();
  const m = DMY.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return s;
}
// What a typed value becomes when the field is left: 3/8/2026, 03082026 and
// 2026-08-03 all turn into 03/08/2026.
export function tidyDmy(text) {
  const s = String(text || "").trim();
  const m = DMY.exec(s) || /^(\d{2})(\d{2})(\d{4})$/.exec(s);
  if (m) return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}`;
  return ISO.test(s) ? dmy(s) : s;
}
