// Makes any picture fit as the business logo before it is uploaded: large
// images are scaled down in the browser and re-encoded, so a photo-sized file
// from a phone works without anyone thinking about megabytes. Small images are
// left as they are (scaling up adds nothing) with a note that they may print
// blurry. The server still refuses anything over 1 MB that is not PNG or JPEG.
export const MAX_BYTES = 1024 * 1024;
// Longest side after scaling: more than enough for a logo printed 8 cm wide.
export const MAX_SIDE = 2000;
// Narrower than this prints soft on A4; the upload goes ahead with a warning.
export const SHARP_WIDTH = 600;
const KEEP_TYPES = ["image/png", "image/jpeg"];

// The attempts, in order, to get an image of w×h and `type` under the limit.
// Each is { side, type, quality }. A picture with transparency stays PNG and
// gets smaller if it must; an opaque one may become a JPEG at full size, which
// beats a smaller PNG for photo-like pictures; a JPEG stays JPEG.
export function attempts(width, height, type, alpha = true) {
  const longest = Math.max(width, height);
  const sides = [
    ...new Set([
      Math.min(longest, MAX_SIDE),
      Math.min(longest, 1600),
      Math.min(longest, 1200),
      Math.min(longest, 900),
    ]),
  ];
  if (type === "image/jpeg")
    return sides.flatMap((side) =>
      [0.92, 0.85].map((quality) => ({ side, type: "image/jpeg", quality })),
    );
  if (alpha) return sides.map((side) => ({ side, type: "image/png" }));
  const out = [];
  for (const side of sides)
    out.push(
      { side, type: "image/png" },
      { side, type: "image/jpeg", quality: 0.92 },
    );
  for (const side of sides)
    out.push({ side, type: "image/jpeg", quality: 0.85 });
  return out;
}

// Whether any pixel of the drawn picture is see-through.
export function hasAlpha(ctx, width, height) {
  const d = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

// Whether the file can be sent exactly as it is.
export const asIs = (file, width, height) =>
  KEEP_TYPES.includes(file.type) &&
  file.size <= MAX_BYTES &&
  Math.max(width, height) <= MAX_SIDE;

// The width and height after scaling the longest side to `side`.
export function scaled(width, height, side) {
  const f = Math.min(1, side / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * f)),
    height: Math.max(1, Math.round(height * f)),
  };
}

// What to tell the person after a successful upload.
export function note({
  width,
  height,
  from,
  resized,
  type = "",
  unknown = false,
}) {
  const parts = [];
  if (unknown) return "";
  if (resized && (width !== from.width || height !== from.height))
    parts.push(
      `Resized from ${from.width}×${from.height} to ${width}×${height}.`,
    );
  else if (resized)
    parts.push(`Converted to ${type === "image/png" ? "PNG" : "JPEG"}.`);
  if (width < SHARP_WIDTH)
    parts.push(
      `The image is small (${width}×${height} px) and may print blurry; a logo at least ${SHARP_WIDTH} px wide prints sharp.`,
    );
  return parts.join(" ");
}

// Decodes the picture. Without createImageBitmap (older Safari) an <img> is
// fed a data: URL: the page's CSP allows data: images, not blob: ones.
const decode = async (file) => {
  if (typeof createImageBitmap === "function") return createImageBitmap(file);
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
};
const toBlob = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));
const ext = (type) => (type === "image/png" ? "png" : "jpg");

// Returns { file, width, height, from, resized } for the logo to upload, or
// throws when the browser cannot read the picture.
export async function fitLogo(file) {
  let image;
  try {
    image = await decode(file);
  } catch {
    // A browser that cannot decode it still sends an acceptable file as it
    // is; the server checks the bytes. Anything else is refused here.
    if (KEEP_TYPES.includes(file.type) && file.size <= MAX_BYTES)
      return {
        file,
        width: 0,
        height: 0,
        from: { width: 0, height: 0 },
        resized: false,
        unknown: true,
      };
    throw new Error(
      "This file is not a picture the browser can read. Use a PNG, JPEG or WebP image.",
    );
  }
  const from = {
    width: image.width || image.naturalWidth,
    height: image.height || image.naturalHeight,
  };
  const base = (file.name || "logo").replace(/\.[^.]+$/, "");
  if (asIs(file, from.width, from.height)) {
    image.close?.();
    return { file, ...from, from, resized: false };
  }
  const draw = (width, height, jpeg) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    // JPEG has no transparency: what was transparent becomes white, not black.
    if (jpeg) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);
    return { canvas, ctx };
  };
  // A small probe says whether the picture has transparency to keep.
  const probe = scaled(from.width, from.height, 400);
  const alpha =
    file.type !== "image/jpeg" &&
    hasAlpha(
      draw(probe.width, probe.height, false).ctx,
      probe.width,
      probe.height,
    );
  for (const a of attempts(from.width, from.height, file.type, alpha)) {
    const { width, height } = scaled(from.width, from.height, a.side);
    const { canvas } = draw(width, height, a.type === "image/jpeg");
    const blob = await toBlob(canvas, a.type, a.quality);
    if (blob && blob.size <= MAX_BYTES) {
      image.close?.();
      return {
        file: new File([blob], `${base}.${ext(a.type)}`, { type: a.type }),
        width,
        height,
        from,
        type: a.type,
        resized:
          width !== from.width ||
          height !== from.height ||
          a.type !== file.type,
      };
    }
  }
  image.close?.();
  throw new Error(
    "This picture stays over 1 MB even when made smaller. Use a simpler logo image (PNG or JPEG).",
  );
}
