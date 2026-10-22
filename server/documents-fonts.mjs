import { readFileSync, statSync } from "node:fs";
import { isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { openSync } from "fontkit";
// Archivo, the interface typeface, is the document face (OFL, see LICENSE-Archivo.txt).
// It covers Latin scripts only, so a string with other characters (Cyrillic,
// Greek, Arabic, Hebrew, ...) is drawn with DejaVu Sans, which has those glyphs.
const fontFile = (name) => fileURLToPath(new URL(`../public/assets/fonts/${name}`, import.meta.url));
export const TEXT_FONTS = {
  Body: fontFile("Archivo-Regular.ttf"),
  Bold: fontFile("Archivo-Bold.ttf"),
  Fallback: fontFile("DejaVuSans.ttf"),
  FallbackBold: fontFile("DejaVuSans-Bold.ttf"),
};
let archivo = null;
// True when Archivo has a glyph for every character of the string. Control
// characters and line breaks are laid out by pdfkit and need no glyph.
export function archivoCovers(value) {
  archivo ??= openSync(TEXT_FONTS.Body);
  for (const ch of String(value ?? "")) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    if (!archivo.hasGlyphForCodePoint(cp)) return false;
  }
  return true;
}
// Registers Body, Bold and their DejaVu fallbacks on a pdfkit document.
export function registerTextFonts(pdf) {
  for (const [name, path] of Object.entries(TEXT_FONTS)) pdf.registerFont(name, path);
}
// The registered font to draw one string with: "Body" or "Bold" in Archivo when
// it covers the text, the DejaVu fallback of the same weight when it does not.
export function textFont(name, value) {
  if (archivoCovers(value)) return name;
  return name === "Bold" ? "FallbackBold" : "Fallback";
}
// Chinese (and other CJK) text needs a CJK font in PDFs: DejaVu has no CJK glyphs
// and would print empty boxes. The font comes from the PDF_CJK_FONT setting or
// from the usual system folders (Debian/Ubuntu: apt install fonts-noto-cjk).
export const CJK =
  /[⺀-⿟　-〿぀-ヿ㄀-ㄯ㆐-ㇿ㐀-䶿一-鿿가-힯豈-﫿︰-﹏＀-￯]|[\u{20000}-\u{2FA1F}]/u;
export const hasCjk = (value) => CJK.test(String(value ?? ""));
export const CJK_MESSAGE =
  "Chinese text needs a Chinese font on the server. Install fonts-noto-cjk, or set PDF_CJK_FONT in Settings > Integration keys to a .ttc, .otf or .ttf font file.";
export const SYSTEM_CJK_FONTS = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/wenquanyi/wqy-microhei/wqy-microhei.ttc",
  "/usr/share/fonts/wenquanyi/wqy-zenhei/wqy-zenhei.ttc",
  "/usr/share/fonts/truetype/arphic/uming.ttc",
  "/Library/Fonts/Arial Unicode.ttf",
];
const FONT_TYPES = [".ttc", ".otc", ".ttf", ".otf"];
const usable = (path) => {
  try {
    if (!path || !isAbsolute(path) || !FONT_TYPES.includes(extname(path).toLowerCase())) return false;
    const s = statSync(path);
    return s.isFile() && s.size > 1000 && s.size < 128 * 1024 * 1024;
  } catch {
    return false;
  }
};
// The configured font when it is usable, otherwise the first system font found.
export function cjkFontPath(configured, candidates = SYSTEM_CJK_FONTS) {
  if (configured && usable(String(configured).trim())) return String(configured).trim();
  return candidates.find(usable) || null;
}
// PostScript names of the fonts inside a TrueType/OpenType collection.
export function collectionNames(buf) {
  if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "ttcf") return null;
  const count = Math.min(buf.readUInt32BE(8), 64);
  const names = [];
  for (let i = 0; i < count; i++) names.push(postscriptName(buf, buf.readUInt32BE(12 + 4 * i)));
  return names.filter(Boolean);
}
function postscriptName(buf, offset) {
  try {
    const tables = buf.readUInt16BE(offset + 4);
    for (let t = 0; t < tables; t++) {
      const rec = offset + 12 + 16 * t;
      if (buf.toString("latin1", rec, rec + 4) !== "name") continue;
      const table = buf.readUInt32BE(rec + 8);
      const count = buf.readUInt16BE(table + 2),
        strings = table + buf.readUInt16BE(table + 4);
      let fallback = null;
      for (let k = 0; k < count; k++) {
        const r = table + 6 + 12 * k;
        if (buf.readUInt16BE(r + 6) !== 6) continue;
        const platform = buf.readUInt16BE(r),
          length = buf.readUInt16BE(r + 8),
          start = strings + buf.readUInt16BE(r + 10);
        const bytes = buf.subarray(start, start + length);
        if (platform === 0 || platform === 3) {
          let s = "";
          for (let j = 0; j + 1 < bytes.length; j += 2) s += String.fromCharCode(bytes.readUInt16BE(j));
          return s;
        }
        if (platform === 1) fallback = bytes.toString("latin1");
      }
      return fallback;
    }
  } catch {
    return null;
  }
  return null;
}
const cache = new Map();
// { data, family } ready for pdfkit's registerFont. Simplified Chinese faces are
// preferred inside collections such as NotoSansCJK-Regular.ttc.
export function loadFontFace(path) {
  if (!path) return null;
  if (cache.has(path)) return cache.get(path);
  let face = null;
  try {
    const data = readFileSync(path);
    const names = collectionNames(data);
    const family = names
      ? names.find((n) => /CJKsc|SC-|SC$|GB|Hans/.test(n) && !/Mono/.test(n)) ||
        names.find((n) => !/Mono/.test(n)) ||
        names[0]
      : null;
    if (!names || family) face = { data, family };
  } catch {
    face = null;
  }
  cache.set(path, face);
  return face;
}
// The bold face next to a regular one (e.g. NotoSansCJK-Bold.ttc), when installed.
export function boldSibling(path) {
  if (!path || !/Regular/.test(path)) return null;
  const bold = path.replace(/Regular(?!.*Regular)/, "Bold");
  return usable(bold) ? bold : null;
}
