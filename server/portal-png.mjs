// Signature images from the client's browser are untrusted. They are decoded
// here before anything is stored or drawn into a PDF, then re-encoded with
// only the image data (no text or metadata chunks).
import { inflateSync, deflateSync, crc32 } from "node:zlib";
import { check } from "./domain.mjs";

export const SIGNATURE_LIMITS = {
  maxBytes: 80 * 1024,
  minWidth: 120,
  maxWidth: 1200,
  minHeight: 40,
  maxHeight: 600,
  // A signature needs some ink, and a signature is mostly empty space.
  minInk: 40,
  maxInkRatio: 0.5,
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Channels per pixel for 8-bit grey, RGB, grey+alpha and RGBA. Palette and
// 16-bit images are refused: browser canvases never produce them.
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
};

const paeth = (a, b, c) => {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// Returns { width, height, ink, png } where png is the clean re-encoded image.
export function inspectSignaturePng(input, limits = SIGNATURE_LIMITS) {
  const bad = "Use a PNG image of your signature.";
  check(Buffer.isBuffer(input) && input.length > 0, bad, 415);
  check(input.length <= limits.maxBytes, "The signature image is too large.", 413);
  check(input.length >= 57 && input.subarray(0, 8).equals(PNG_SIGNATURE), bad, 415);
  let offset = 8,
    header = null,
    ended = false;
  const idat = [];
  while (offset < input.length) {
    check(offset + 12 <= input.length, "The signature image is incomplete.");
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString("latin1");
    check(/^[A-Za-z]{4}$/.test(type), "The signature image is damaged.");
    check(length <= input.length - offset - 12, "The signature image is incomplete.");
    const data = input.subarray(offset + 8, offset + 8 + length);
    const stored = input.readUInt32BE(offset + 8 + length);
    check(
      (crc32(input.subarray(offset + 4, offset + 8 + length)) >>> 0) === stored,
      "The signature image is damaged.",
    );
    offset += 12 + length;
    if (!header) {
      check(type === "IHDR" && length === 13, bad, 415);
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
        raw: Buffer.from(data),
      };
      continue;
    }
    if (type === "IDAT") idat.push(data);
    else if (type === "IEND") {
      ended = true;
      break;
    } else check(type[0] === type[0].toLowerCase(), "The signature image uses an unsupported format.");
  }
  check(header && ended && idat.length, "The signature image is incomplete.");
  check(offset === input.length, "The signature image has unexpected data after its end.");
  const { width, height } = header;
  check(
    width >= limits.minWidth && width <= limits.maxWidth && height >= limits.minHeight && height <= limits.maxHeight,
    `The signature image must be between ${limits.minWidth}×${limits.minHeight} and ${limits.maxWidth}×${limits.maxHeight} pixels.`,
  );
  const channels = CHANNELS[header.color];
  check(
    header.depth === 8 && channels && header.compression === 0 && header.filter === 0 && header.interlace === 0,
    "The signature image uses an unsupported PNG format.",
  );
  const stride = width * channels;
  const expected = height * (stride + 1);
  let raw;
  try {
    // The output limit stops a small compressed file from expanding without bound.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    check(false, "The signature image is damaged.");
  }
  check(raw.length === expected, "The signature image is damaged.");
  const prev = Buffer.alloc(stride),
    row = Buffer.alloc(stride);
  let ink = 0;
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1),
      type = raw[start];
    check(type <= 4, "The signature image is damaged.");
    for (let i = 0; i < stride; i++) {
      const x = raw[start + 1 + i],
        a = i >= channels ? row[i - channels] : 0,
        b = prev[i],
        c = i >= channels ? prev[i - channels] : 0;
      row[i] =
        (type === 0 ? x : type === 1 ? x + a : type === 2 ? x + b : type === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) &
        0xff;
    }
    for (let i = 0; i < stride; i += channels) {
      const grey = channels < 3 ? row[i] : (row[i] * 299 + row[i + 1] * 587 + row[i + 2] * 114) / 1000;
      const alpha = channels === 2 ? row[i + 1] : channels === 4 ? row[i + 3] : 255;
      if (alpha >= 64 && grey < 160) ink++;
    }
    row.copy(prev);
  }
  check(ink >= limits.minInk, "The signature is empty. Draw or type your signature.");
  check(ink <= width * height * limits.maxInkRatio, "This image does not look like a signature.");
  const png = Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header.raw),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { width, height, ink, png };
}

// Accepts base64 or a data:image/png;base64 URL from a canvas.
export function decodeSignature(value) {
  check(typeof value === "string" && value.length > 0, "Draw or type your signature.");
  const b64 = value.replace(/^data:image\/png;base64,/, "");
  check(
    b64.length <= Math.ceil((SIGNATURE_LIMITS.maxBytes * 4) / 3) + 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64),
    "Use a PNG image of your signature.",
    415,
  );
  return Buffer.from(b64, "base64");
}
