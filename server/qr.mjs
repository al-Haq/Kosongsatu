import qrcode from "qrcode-generator";
import { check } from "./domain.mjs";
// QR codes for payment payloads, e-Invoice validation links and authenticator setup.
// Returns the module matrix so callers can draw vectors (PDF) or SVG (browser).
export function qrMatrix(value, level = "M") {
  check(
    typeof value === "string" && value.length > 0 && value.length <= 1200,
    "QR content must be 1 to 1200 characters.",
  );
  const q = qrcode(0, level);
  q.addData(value, "Byte");
  q.make();
  const size = q.getModuleCount();
  const rows = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(q.isDark(r, c));
    rows.push(row);
  }
  return rows;
}
// A self-contained SVG with a 4-module quiet zone, safe to embed as a data URI.
export function qrSvg(value, { level = "M", dark = "#0F172A", light = "#FFFFFF" } = {}) {
  const m = qrMatrix(value, level),
    n = m.length + 8;
  let path = "";
  m.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) path += `M${x + 4} ${y + 4}h1v1h-1z`;
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
export const qrDataUri = (value, options) =>
  "data:image/svg+xml;base64," + Buffer.from(qrSvg(value, options)).toString("base64");
// Draws a QR code on a PDFKit document at (x, y) with the given outer size in points.
export function drawQr(pdf, value, x, y, size, { level = "M", color = "#0F172A" } = {}) {
  const m = qrMatrix(value, level),
    n = m.length + 8,
    cell = size / n;
  pdf.save();
  pdf.rect(x, y, size, size).fill("#FFFFFF");
  pdf.fillColor(color);
  m.forEach((row, r) =>
    row.forEach((on, c) => {
      if (on) pdf.rect(x + (c + 4) * cell, y + (r + 4) * cell, cell + 0.05, cell + 0.05);
    }),
  );
  pdf.fill();
  pdf.restore();
}
