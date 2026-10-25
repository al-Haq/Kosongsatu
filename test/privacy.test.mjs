// A person's IC or passport number shows only its last 4 characters on documents.
import test from "node:test";
import assert from "node:assert/strict";
import { maskId, personalId, documentId } from "../public/ext/privacy.mjs";

test("maskId keeps the last 4 letters or digits and the shape", () => {
  assert.equal(maskId("900101-14-5678"), "******-**-5678");
  assert.equal(maskId("900101145678"), "********5678");
  assert.equal(maskId("A12345678"), "*****5678");
  assert.equal(maskId("A1234 5678"), "***** 5678");
  assert.equal(maskId("5678"), "5678");
  assert.equal(maskId("12"), "12");
  assert.equal(maskId(""), "");
  assert.equal(maskId(null), "");
  assert.equal(maskId("900101-14-5678", 0), "******-**-****");
});

test("only a person's number is masked; a business registration shows in full", () => {
  assert.equal(personalId({ kind: "individual", brn: "900101-14-5678" }), true);
  // Filed as a company by the migration that added the type, but the number is a MyKad.
  assert.equal(personalId({ kind: "company", brn: "900101-14-5678" }), true);
  assert.equal(personalId({ kind: "company", brn: "202001012345" }), false);
  assert.equal(
    personalId({ kind: "company", tax_id_type: "NRIC", brn: "900101145678" }),
    true,
  );
  assert.equal(
    personalId({
      kind: "organisation",
      tax_id_type: "PASSPORT",
      brn: "A1234567",
    }),
    true,
  );
  // Older issued snapshots have no kind at all: the same rule applies.
  assert.equal(personalId({ brn: "900101-14-5678" }), true);
  assert.equal(personalId({ brn: "202001012345" }), false);
  assert.equal(personalId({ brn: "1234567-A" }), false);

  assert.equal(
    documentId({ kind: "individual", brn: "900101-14-5678" }),
    "******-**-5678",
  );
  assert.equal(
    documentId({
      kind: "individual",
      tax_id_type: "PASSPORT",
      brn: "A12345678",
    }),
    "*****5678",
  );
  assert.equal(
    documentId({ kind: "company", brn: "202001012345" }),
    "202001012345",
  );
  assert.equal(documentId({ kind: "government", brn: "" }), "");
});
