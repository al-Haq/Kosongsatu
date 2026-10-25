// Any picture fits as the logo: large ones are scaled down in the browser.
// The planning parts are pure; the canvas work is covered by the browser tests.
import test from "node:test";
import assert from "node:assert/strict";
import {
  attempts,
  asIs,
  scaled,
  note,
  MAX_BYTES,
  MAX_SIDE,
} from "../public/ext/logo-fit.mjs";

test("a PNG or JPEG under 1 MB and 2000 px goes up exactly as it is", () => {
  assert.equal(asIs({ type: "image/png", size: 300000 }, 1600, 400), true);
  assert.equal(asIs({ type: "image/jpeg", size: MAX_BYTES }, 2000, 2000), true);
  assert.equal(
    asIs({ type: "image/png", size: MAX_BYTES + 1 }, 1600, 400),
    false,
    "too big",
  );
  assert.equal(
    asIs({ type: "image/png", size: 1000 }, 2001, 400),
    false,
    "too wide",
  );
  assert.equal(
    asIs({ type: "image/webp", size: 1000 }, 800, 200),
    false,
    "WebP is re-encoded",
  );
});

test("scaling keeps the shape and never enlarges", () => {
  assert.deepEqual(scaled(4000, 1000, MAX_SIDE), { width: 2000, height: 500 });
  assert.deepEqual(scaled(1000, 4000, 1200), { width: 300, height: 1200 });
  assert.deepEqual(scaled(800, 200, MAX_SIDE), { width: 800, height: 200 });
  assert.deepEqual(scaled(3, 1, 1), { width: 1, height: 1 });
});

test("attempts: transparency stays PNG; an opaque picture may become a full-size JPEG; a JPEG stays JPEG", () => {
  const transparent = attempts(4000, 1000, "image/png", true);
  assert.deepEqual(transparent, [
    { side: 2000, type: "image/png" },
    { side: 1600, type: "image/png" },
    { side: 1200, type: "image/png" },
    { side: 900, type: "image/png" },
  ]);
  const opaque = attempts(4000, 1000, "image/png", false);
  assert.deepEqual(opaque.slice(0, 3), [
    { side: 2000, type: "image/png" },
    { side: 2000, type: "image/jpeg", quality: 0.92 },
    { side: 1600, type: "image/png" },
  ]);
  assert.deepEqual(opaque.at(-1), {
    side: 900,
    type: "image/jpeg",
    quality: 0.85,
  });
  assert.equal(opaque.length, 8 + 4);
  const jpeg = attempts(4000, 1000, "image/jpeg", false);
  assert.ok(jpeg.every((a) => a.type === "image/jpeg"));
  assert.equal(jpeg.length, 8);
  // A small picture is never scaled up: one side only.
  const small = attempts(500, 100, "image/webp", true);
  assert.deepEqual(small, [{ side: 500, type: "image/png" }]);
});

test("the note says what happened and warns about small logos", () => {
  assert.equal(
    note({
      width: 2000,
      height: 500,
      from: { width: 4000, height: 1000 },
      resized: true,
    }),
    "Resized from 4000×1000 to 2000×500.",
  );
  assert.equal(
    note({
      width: 1600,
      height: 400,
      from: { width: 1600, height: 400 },
      resized: false,
    }),
    "",
  );
  assert.equal(
    note({
      width: 800,
      height: 200,
      from: { width: 800, height: 200 },
      resized: true,
      type: "image/png",
    }),
    "Converted to PNG.",
  );
  // Sent as it is because the browser could not read it: nothing to say about its size.
  assert.equal(
    note({
      width: 0,
      height: 0,
      from: { width: 0, height: 0 },
      resized: false,
      unknown: true,
    }),
    "",
  );
  assert.match(
    note({
      width: 300,
      height: 80,
      from: { width: 300, height: 80 },
      resized: false,
    }),
    /small \(300×80 px\) and may print blurry/,
  );
});
