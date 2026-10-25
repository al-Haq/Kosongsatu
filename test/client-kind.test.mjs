// A client is a company (or other organisation) or an individual person.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { buyerParty, buyerGaps } from "../server/tax-myinvois.mjs";

test("clients are companies unless saved as individuals; an individual keeps no contact person or SST number", async () => {
  const f = await fixture();
  try {
    const company = await f.json("/api/clients", "POST", {
      name: "Vatex Sdn Bhd",
      contact: "Luqman",
      sst_number: "W10-1808-32000001",
    });
    assert.equal(company.kind, "company");
    assert.equal(company.contact, "Luqman");

    const person = await f.json("/api/clients", "POST", {
      kind: "individual",
      name: "Aminah binti Ali",
      contact: "left over from the company form",
      sst_number: "W10-0000-00000000",
      brn: "900101-14-5678",
      phone: "012-345 6789",
    });
    assert.equal(person.kind, "individual");
    assert.equal(person.contact, "");
    assert.equal(person.sst_number, "");
    assert.equal(person.brn, "900101-14-5678");

    // Saving without a type keeps the one it has.
    const renamed = await f.json(`/api/clients/${person.id}`, "PUT", {
      name: "Aminah Ali",
      brn: person.brn,
    });
    assert.equal(renamed.kind, "individual");

    // A company can become an individual and back.
    const changed = await f.json(`/api/clients/${company.id}`, "PUT", {
      ...company,
      kind: "individual",
    });
    assert.equal(changed.kind, "individual");
    assert.equal(changed.contact, "");
    const back = await f.json(`/api/clients/${company.id}`, "PUT", {
      ...changed,
      kind: "company",
      contact: "Luqman",
    });
    assert.equal(back.kind, "company");
    assert.equal(back.contact, "Luqman");

    await assert.rejects(
      f.json("/api/clients", "POST", { name: "Someone", kind: "robot" }),
      /Choose the client type/,
    );
    const agency = await f.json("/api/clients", "POST", {
      kind: "government",
      name: "Majlis Daerah Hulu Selangor",
      contact: "En. Rashid",
    });
    assert.equal(agency.kind, "government");
    assert.equal(agency.contact, "En. Rashid");
    const ngo = await f.json("/api/clients", "POST", {
      kind: "organisation",
      name: "Persatuan Belia Rawang",
      brn: "PPM-001-10-01012020",
    });
    assert.equal(ngo.kind, "organisation");

    // The type is kept on the document when it is issued.
    const draft = await f.json("/api/documents", "POST", {
      kind: "invoice",
      client_id: person.id,
      issue_date: "2026-10-25",
      due_date: "2026-11-08",
      items: [{ description: "Tuition", quantity: 1, rate: "150.00" }],
    });
    const issued = await f.json(`/api/documents/${draft.id}/issue`, "POST", {});
    assert.equal(issued.client.kind, "individual");
  } finally {
    await f.close();
  }
});

test("e-Invoice buyer: an individual is identified by MyKad or passport, with LHDN's general TIN when they have none", () => {
  const address = {
    tax_addr_lines: "1 Jalan Ampang",
    tax_city: "Kuala Lumpur",
    tax_postcode: "50450",
    tax_state: "14",
    tax_country: "MYS",
  };
  const malaysian = buyerParty({
    kind: "individual",
    name: "Aminah",
    brn: "900101-14-5678",
    phone: "0123456789",
    ...address,
  });
  assert.equal(malaysian.idType, "NRIC");
  assert.equal(malaysian.idValue, "900101145678");
  assert.equal(malaysian.tin, "EI00000000010");
  assert.deepEqual(
    buyerGaps({
      kind: "individual",
      name: "Aminah",
      brn: "900101-14-5678",
      phone: "0123456789",
      ...address,
    }),
    [],
  );

  const foreigner = buyerParty({
    kind: "individual",
    name: "John",
    brn: "A1234 5678",
    phone: "+447700900123",
    ...address,
  });
  assert.equal(foreigner.idType, "PASSPORT");
  assert.equal(foreigner.idValue, "A12345678");
  assert.equal(foreigner.tin, "EI00000000020");

  // Their own TIN, or an ID type set in the tax fields, wins.
  const withTin = buyerParty({
    kind: "individual",
    name: "Aminah",
    brn: "900101145678",
    tin: "IG12345678090",
  });
  assert.equal(withTin.tin, "IG12345678090");
  const army = buyerParty({
    kind: "individual",
    name: "Kapt. Ali",
    brn: "T1234567",
    tax_id_type: "ARMY",
  });
  assert.equal(army.idType, "ARMY");
  assert.equal(army.idValue, "T1234567");
  assert.equal(army.tin, "");

  // No ID at all: no general TIN either, so the gap is shown.
  const unknown = buyerParty({ kind: "individual", name: "Walk-in" });
  assert.equal(unknown.tin, "");
  assert.ok(
    buyerGaps({ kind: "individual", name: "Walk-in", ...address }).includes(
      "Buyer TIN",
    ),
  );

  // A government body: its own TIN and number when known, else LHDN's general TIN and "NA".
  const agency = buyerParty({
    kind: "government",
    name: "Majlis Daerah",
    phone: "0123456789",
    ...address,
  });
  assert.equal(agency.tin, "EI00000000040");
  assert.equal(agency.idType, "BRN");
  assert.equal(agency.idValue, "NA");
  assert.deepEqual(
    buyerGaps({
      kind: "government",
      name: "Majlis Daerah",
      phone: "0123456789",
      ...address,
    }),
    [],
  );
  const ministry = buyerParty({
    kind: "government",
    name: "Kementerian",
    tin: "C98765432100",
    brn: "202001000001",
  });
  assert.equal(ministry.tin, "C98765432100");
  assert.equal(ministry.idValue, "202001000001");
  // An organisation is identified like a company.
  const ngo = buyerParty({
    kind: "organisation",
    name: "Persatuan",
    brn: "202001012345",
    tin: "C12345678901",
  });
  assert.equal(ngo.idType, "BRN");
  assert.equal(ngo.tin, "C12345678901");

  // Companies (and clients saved before the type existed) are unchanged.
  for (const kind of ["company", undefined]) {
    const company = buyerParty({
      kind,
      name: "Vatex Sdn Bhd",
      brn: "202001012345",
      tin: "C12345678901",
    });
    assert.equal(company.idType, "BRN");
    assert.equal(company.idValue, "202001012345");
    assert.equal(company.tin, "C12345678901");
  }
});
