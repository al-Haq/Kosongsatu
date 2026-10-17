import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createVerify, X509Certificate } from "node:crypto";
import {
  buildDocument,
  certificateInfo,
  distinguishedName,
  normalizePem,
  signDocument,
  signingMaterial,
  submissionEntry,
  verifyDocument,
} from "../server/tax-ubl.mjs";
import { selfSignedCert } from "./tax-helpers.mjs";

const party = {
  tin: "C25845632020",
  idType: "BRN",
  idValue: "202001012345",
  name: "Nawlogic Systems Solution",
  phone: "+60312345678",
  msic: "62010",
  activity: "Computer programming activities",
  address: { lines: ["Level 1"], city: "Kuala Lumpur", postcode: "50450", state: "14", country: "MYS" },
};
const sample = () =>
  buildDocument({
    typeCode: "01",
    number: "INV-2026-0001",
    issuedAt: "2026-10-17T01:02:03Z",
    supplier: party,
    buyer: { ...party, name: "Buyer" },
    lines: [
      {
        description: "Support",
        quantity: 2,
        unitPrice: 50000,
        subtotal: 100000,
        discount: 10000,
        net: 90000,
        classes: ["022"],
        tax: { category: "02", rate: 8, taxable: 90000, tax: 7200 },
      },
    ],
  });
const cert = selfSignedCert({ cn: "Nawlogic Signer", org: "Nawlogic", issuerCn: "Trial CA" });

test("UBL JSON follows the MyInvois binding and totals add up", () => {
  const doc = sample();
  assert.equal(doc._D, "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2");
  const inv = doc.Invoice[0];
  assert.deepEqual(inv.InvoiceTypeCode, [{ _: "01", listVersionID: "1.0" }]);
  assert.deepEqual(inv.IssueDate, [{ _: "2026-10-17" }]);
  assert.deepEqual(inv.IssueTime, [{ _: "01:02:03Z" }]);
  assert.equal(inv.AccountingSupplierParty[0].Party[0].IndustryClassificationCode[0]._, "62010");
  assert.equal(inv.AccountingCustomerParty[0].Party[0].IndustryClassificationCode, undefined);
  assert.deepEqual(
    inv.AccountingSupplierParty[0].Party[0].PartyIdentification.map((p) => p.ID[0].schemeID),
    ["TIN", "BRN", "SST", "TTX"],
  );
  assert.deepEqual(inv.LegalMonetaryTotal[0].TaxInclusiveAmount, [{ _: 972, currencyID: "MYR" }]);
  assert.deepEqual(inv.TaxTotal[0].TaxSubtotal[0].TaxCategory[0].ID, [{ _: "02" }]);
  const line = inv.InvoiceLine[0];
  assert.deepEqual(line.ItemPriceExtension[0].Amount, [{ _: 1000, currencyID: "MYR" }]);
  assert.deepEqual(line.LineExtensionAmount, [{ _: 900, currencyID: "MYR" }]);
  assert.deepEqual(line.Item[0].CommodityClassification[0].ItemClassificationCode, [{ _: "022", listID: "CLASS" }]);
});

test("a self-signed certificate signs a v1.1 document that verifies, and tampering is detected", () => {
  const material = signingMaterial({ key: cert.keyPem, cert: cert.certPem });
  const { document, json, digests } = signDocument(sample(), material, new Date("2026-10-17T01:05:00Z"));
  assert.equal(document.Invoice[0].InvoiceTypeCode[0].listVersionID, "1.1");
  const sig = document.Invoice[0].UBLExtensions[0].UBLExtension[0].ExtensionContent[0].UBLDocumentSignatures[0].SignatureInformation[0].Signature[0];
  assert.equal(sig.Id, "signature");
  assert.equal(sig.SignedInfo[0].Reference[0].URI, "#id-xades-signed-props");
  assert.equal(sig.SignedInfo[0].Reference[1].DigestValue[0]._, digests.docDigest);
  const props = sig.Object[0].QualifyingProperties[0];
  assert.equal(props.SignedProperties[0].SignedSignatureProperties[0].SigningTime[0]._, "2026-10-17T01:05:00Z");
  // DocDigest is over the document without UBLExtensions/Signature; Sig is RSA-SHA256 over the same bytes.
  const { UBLExtensions, Signature, ...body } = document.Invoice[0];
  const stripped = JSON.stringify({ ...document, Invoice: [body] });
  assert.equal(digests.docDigest, createHash("sha256").update(stripped).digest("base64"));
  assert.ok(createVerify("SHA256").update(stripped).verify(cert.publicKey, digests.signatureValue, "base64"));
  // PropsDigest covers the QualifyingProperties object with its Target.
  assert.equal(digests.propsDigest, createHash("sha256").update(JSON.stringify(props)).digest("base64"));
  const x509 = new X509Certificate(cert.certPem);
  assert.equal(digests.certDigest, createHash("sha256").update(x509.raw).digest("base64"));
  const serial = props.SignedProperties[0].SignedSignatureProperties[0].SigningCertificate[0].Cert[0].IssuerSerial[0].X509SerialNumber[0]._;
  assert.equal(serial, BigInt("0x0a1b2c3d4e").toString(10), "serial in decimal");
  assert.deepEqual(verifyDocument(json), { valid: true, documentDigest: true, propertiesDigest: true, signature: true, certDigest: true });
  const tampered = JSON.parse(json);
  tampered.Invoice[0].LegalMonetaryTotal[0].PayableAmount[0]._ = 1;
  const v = verifyDocument(tampered);
  assert.equal(v.valid, false);
  assert.equal(v.documentDigest, false);
  assert.equal(v.signature, false);
  const props2 = JSON.parse(json);
  props2.Invoice[0].UBLExtensions[0].UBLExtension[0].ExtensionContent[0].UBLDocumentSignatures[0].SignatureInformation[0].Signature[0].Object[0].QualifyingProperties[0].SignedProperties[0].SignedSignatureProperties[0].SigningTime[0]._ = "2020-01-01T00:00:00Z";
  assert.equal(verifyDocument(props2).propertiesDigest, false);
});

test("issuer names follow LHDN's order and PEM pasted on one line still works", () => {
  assert.equal(distinguishedName("CN=Trial CA\nO=LHDNM\nOU=Terms\nC=MY"), "C=MY, O=LHDNM, OU=Terms, CN=Trial CA");
  assert.equal(distinguishedName("emailAddress=a@b.my\nCN=X\nC=MY"), "C=MY, E=a@b.my, CN=X");
  const info = certificateInfo(new X509Certificate(cert.certPem));
  assert.equal(info.issuer, "C=MY, O=Nawlogic, CN=Trial CA");
  assert.equal(info.subject, "C=MY, O=Nawlogic, CN=Nawlogic Signer");
  const oneLine = cert.keyPem.replace(/\n/g, " ");
  assert.equal(normalizePem(oneLine)[0], cert.keyPem.endsWith("\n") ? cert.keyPem : cert.keyPem + "\n");
  // Key and certificate pasted together in the key field.
  const m = signingMaterial({ key: oneLine + " " + cert.certPem.replace(/\n/g, " "), cert: "" });
  assert.ok(m.certificate.checkPrivateKey(m.privateKey));
});

test("a key that does not match the certificate, or a missing part, is refused", () => {
  const other = selfSignedCert();
  assert.throws(() => signingMaterial({ key: other.keyPem, cert: cert.certPem }), /does not belong/);
  assert.throws(() => signingMaterial({ key: "", cert: cert.certPem }), /Add both/);
  assert.throws(() => signingMaterial({ key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", cert: cert.certPem }), /could not be read/);
});

test("the submission entry hashes the raw document in hex and base64-encodes the same bytes", () => {
  const json = JSON.stringify(sample());
  const e = submissionEntry(json, "INV-2026-0001");
  assert.equal(e.format, "JSON");
  assert.equal(e.documentHash, createHash("sha256").update(json).digest("hex"));
  assert.equal(Buffer.from(e.document, "base64").toString("utf8"), json);
  assert.equal(e.codeNumber, "INV-2026-0001");
});
