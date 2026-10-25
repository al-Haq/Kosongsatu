// Line item descriptions under the item title: short formatted text (bold,
// italic, strikethrough, bullet and numbered lists) kept as a small,
// safe markup. One parser for the editor, the document page and the PDF:
//   **bold**  *italic*  ~~strike~~   "- item" (bullets)   "1. item" (numbered)
// A blank line separates paragraphs. Text is never HTML: it is escaped when shown.
export const DETAILS_MAX = 3000;

// Inline runs: [{ text, b, i, s }]. A backslash keeps the next character literal.
export function runs(line) {
  const out = [];
  const state = { b: false, i: false, s: false };
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, b: state.b, i: state.i, s: state.s });
    buf = "";
  };
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === "\\" && k + 1 < line.length) {
      buf += line[++k];
      continue;
    }
    if (c === "*" && line[k + 1] === "*") {
      flush();
      state.b = !state.b;
      k++;
      continue;
    }
    if (c === "~" && line[k + 1] === "~") {
      flush();
      state.s = !state.s;
      k++;
      continue;
    }
    if (c === "*") {
      flush();
      state.i = !state.i;
      continue;
    }
    buf += c;
  }
  flush();
  return out;
}

// Blocks: { type: "p", lines: [runs] } | { type: "ul" | "ol", items: [runs] }.
export function blocks(md) {
  const out = [];
  let current = null;
  for (const raw of String(md || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-•]|\*(?!\*))\s+(.*)$/);
    const number = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/);
    if (!line.trim()) {
      current = null;
      continue;
    }
    if (bullet || number) {
      const type = bullet ? "ul" : "ol";
      if (!current || current.type !== type) out.push((current = { type, items: [] }));
      current.items.push(runs((bullet || number)[1]));
      continue;
    }
    if (!current || current.type !== "p") out.push((current = { type: "p", lines: [] }));
    current.lines.push(runs(line.trim()));
  }
  return out;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const runHtml = (r) => {
  let h = esc(r.text);
  if (r.s) h = `<s>${h}</s>`;
  if (r.i) h = `<em>${h}</em>`;
  if (r.b) h = `<strong>${h}</strong>`;
  return h;
};
const lineHtml = (rs) => rs.map(runHtml).join("");

// Safe HTML for the document page and the editor.
export function detailsHtml(md) {
  return blocks(md)
    .map((b) =>
      b.type === "p" ? `<p>${b.lines.map(lineHtml).join("<br>")}</p>` : `<${b.type}>${b.items.map((it) => `<li>${lineHtml(it)}</li>`).join("")}</${b.type}>`,
    )
    .join("");
}

// Plain text (search, e-Invoice, CSV): formatting removed, lists kept readable.
export function detailsPlain(md) {
  return blocks(md)
    .map((b) =>
      b.type === "p"
        ? b.lines.map((l) => l.map((r) => r.text).join("")).join("\n")
        : b.items.map((it, n) => `${b.type === "ol" ? n + 1 + "." : "-"} ${it.map((r) => r.text).join("")}`).join("\n"),
    )
    .join("\n\n");
}

// Markup from the editor's formatted box (browser): bold, italic,
// strikethrough, lists and line breaks are kept; anything else becomes text.
// Never shortened: the counter shows what is over DETAILS_MAX and saving is refused.
export function htmlToDetails(root) {
  // Stars, tildes and backslashes typed as text stay text; no-break spaces become spaces.
  const lit = (s) => s.replace(/([\\*~])/g, "\\$1").replace(/\u00a0/g, " ");
  // Formatted text as runs ({ text, b, i, s } or "\n"), then written with a
  // marker only where the formatting changes. Wrapping each piece on its own
  // would put markers side by side ("*a****b***") that read back wrongly.
  const collect = (node, f, out) => {
    if (node.nodeType === 3) {
      const t = lit(node.nodeValue);
      if (t) out.push({ text: t, b: !!f.b, i: !!f.i, s: !!f.s });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === "BR") return void out.push("\n");
    const style = node.getAttribute?.("style") || "";
    const g = {
      b: f.b || tag === "B" || tag === "STRONG" || /font-weight:\s*(bold|[6-9]00)/.test(style),
      i: f.i || tag === "I" || tag === "EM" || /font-style:\s*italic/.test(style),
      s: f.s || tag === "S" || tag === "STRIKE" || tag === "DEL" || /line-through/.test(style),
    };
    for (const c of node.childNodes) collect(c, g, out);
  };
  const MARK = { b: "**", i: "*", s: "~~" };
  const write = (segs) => {
    let state = { b: false, i: false, s: false },
      line = "";
    const out = [];
    const to = (next) => {
      let m = "";
      for (const k of ["s", "i", "b"]) if (state[k] && !next[k]) m += MARK[k];
      for (const k of ["b", "i", "s"]) if (!state[k] && next[k]) m += MARK[k];
      state = { b: !!next.b, i: !!next.i, s: !!next.s };
      return m;
    };
    // Each line starts with no formatting (runs() reads line by line).
    for (const seg of segs) {
      if (seg === "\n") {
        out.push(line + to({}));
        line = "";
      } else line += to(seg) + seg.text;
    }
    out.push(line + to({}));
    return out.join("\n");
  };
  const inline = (...nodes) => {
    const segs = [];
    for (const n of nodes) collect(n, {}, segs);
    return write(segs);
  };
  const lines = [];
  const block = (node) => {
    if (node.nodeType === 3) {
      if (node.nodeValue.trim()) lines.push(inline(node));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === "UL" || tag === "OL") {
      lines.push("");
      let n = 0;
      for (const li of node.children) if (li.tagName === "LI") lines.push(`${tag === "OL" ? ++n + "." : "-"} ${inline(li).replace(/\n+/g, " ").trim()}`);
      lines.push("");
      return;
    }
    if (tag === "DIV" || tag === "P") {
      const hasBlocks = [...node.children].some((c) => ["UL", "OL", "DIV", "P"].includes(c.tagName));
      if (hasBlocks) [...node.childNodes].forEach(block);
      else lines.push(inline(node));
      // A paragraph ends with a blank line, so it stays a paragraph when saved again.
      if (tag === "P") lines.push("");
      return;
    }
    lines.push(inline(node));
  };
  // Inline nodes directly in the box belong to one line until a block starts.
  let pending = [];
  const flush = () => {
    if (pending.length) lines.push(inline(...pending));
    pending = [];
  };
  for (const node of root.childNodes) {
    if (node.nodeType === 1 && ["UL", "OL", "DIV", "P"].includes(node.tagName)) {
      flush();
      block(node);
    } else pending.push(node);
  }
  flush();
  return lines
    .join("\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
