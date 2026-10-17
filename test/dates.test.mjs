import test from "node:test";
import assert from "node:assert/strict";
import { dmy, isoDate, tidyDmy } from "../public/dates.mjs";

test("dates are shown as dd/mm/yyyy and read back as ISO", () => {
  assert.equal(dmy("2026-08-03"), "03/08/2026");
  assert.equal(dmy(""), "");
  assert.equal(dmy("03/08/2026"), "03/08/2026");
  assert.equal(isoDate("03/08/2026"), "2026-08-03");
  assert.equal(isoDate("3/8/2026"), "2026-08-03");
  assert.equal(isoDate("03-08-2026"), "2026-08-03");
  assert.equal(isoDate("2026-08-03"), "2026-08-03");
  assert.equal(isoDate(" "), "");
  assert.equal(isoDate("abc"), "abc");
  assert.equal(tidyDmy("3/8/2026"), "03/08/2026");
  assert.equal(tidyDmy("03082026"), "03/08/2026");
  assert.equal(tidyDmy("2026-08-03"), "03/08/2026");
  assert.equal(tidyDmy("x"), "x");
});
