// MyInvois UBL 2.1 JSON documents and their XAdES-style signature (version 1.1).
//
// Document shape: the OASIS UBL JSON binding used by MyInvois. Every element is an
// array and leaf values sit under "_" next to their attributes. All eight e-Invoice
// types share the Invoice root; InvoiceTypeCode selects the type.
//
// Signing follows the MyInvois SDK "Signature creation (JSON)" procedure:
//  1. remove UBLExtensions and Signature, minify (JSON.stringify)
//  2. DocDigest   = base64(SHA-256(minified document))
//  3. Sig         = base64(RSA-SHA256 signature over the minified document)
//  4. CertDigest  = base64(SHA-256(DER certificate))
//  5. signed properties: signing time, CertDigest, issuer name, serial (decimal)
//  6. PropsDigest = base64(SHA-256(minified QualifyingProperties object))
//  7. attach UBLExtensions and the cac:Signature pointer.
// Only node:crypto is used. See docs/features/tax.md for sources.
import {
  createHash,
  createSign,
  createVerify,
  createPrivateKey,
  X509Certificate,
} from "node:crypto";
import { AppError } from "./domain.mjs";
import { toMyr } from "./tax-sst.mjs";

export const NAMESPACES = {
  _D: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  _A: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  _B: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
};
const SIGNATURE_ID = "urn:oasis:names:specification:ubl:signature:Invoice";
const SIGNATURE_METHOD = "urn:oasis:names:specification:ubl:dsig:enveloped:xades";
const DIGEST = "http://www.w3.org/2001/04/xmlenc#sha256";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const PROPS_TYPE = "http://uri.etsi.org/01903/v1.3.2#SignedProperties";
const PROPS_ID = "id-xades-signed-props";

const v = (value, attrs = {}) => [{ _: value, ...attrs }];
const money = (sen) => Number((sen / 100).toFixed(2));
const amount = (sen, currency) => v(money(sen), { currencyID: currency });
const TAX_SCHEME = [{ ID: v("OTH", { schemeID: "UN/ECE 5153", schemeAgencyID: "6" }) }];
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));

// ISO date and time (UTC, seconds) as MyInvois expects: "2026-10-17", "03:15:00Z".
export function issueStamp(when = new Date()) {
  const iso = new Date(when).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) + "Z", iso: iso.slice(0, 19) + "Z" };
}

function party(p, supplier) {
  const a = p.address;
  return [
    compact({
      IndustryClassificationCode: supplier ? v(p.msic, { name: p.activity }) : undefined,
      PartyIdentification: [
        { ID: v(p.tin, { schemeID: "TIN" }) },
        { ID: v(p.idValue || "NA", { schemeID: p.idType || "BRN" }) },
        { ID: v(p.sst || "NA", { schemeID: "SST" }) },
        { ID: v(p.ttx || "NA", { schemeID: "TTX" }) },
      ],
      PostalAddress: [
        compact({
          CityName: v(a.city || "NA"),
          PostalZone: a.postcode ? v(a.postcode) : undefined,
          CountrySubentityCode: v(a.state || "17"),
          AddressLine: (a.lines?.length ? a.lines : ["NA"]).slice(0, 3).map((line) => ({ Line: v(line) })),
          Country: [{ IdentificationCode: v(a.country || "MYS", { listID: "ISO3166-1", listAgencyID: "6" }) }],
        }),
      ],
      PartyLegalEntity: [{ RegistrationName: v(p.name) }],
      Contact: [compact({ Telephone: v(p.phone || "NA"), ElectronicMail: p.email ? v(p.email) : undefined })],
    }),
  ];
}
function taxTotal(rows, currency, fx) {
  const tax = rows.reduce((s, r) => s + toMyr(r.tax, fx), 0);
  return [
    {
      TaxAmount: amount(tax, "MYR"),
      TaxSubtotal: rows.map((r) => ({
        TaxableAmount: amount(r.taxable, currency),
        TaxAmount: amount(toMyr(r.tax, fx), "MYR"),
        Percent: v(r.rate),
        TaxCategory: [
          compact({
            ID: v(r.category),
            TaxExemptionReason: r.category === "E" ? v(r.exemption || "Exempted") : undefined,
            TaxScheme: TAX_SCHEME,
          }),
        ],
      })),
    },
  ];
}

// p: { typeCode, number, issuedAt, currency, fxRate, supplier, buyer, lines, billing }
// line: { description, quantity, unitPrice, subtotal, discount, net, unitCode?,
//         classes: [code], tax: { category, rate, taxable, tax, exemption? } }
export function buildDocument(p) {
  const currency = p.currency || "MYR",
    fx = currency === "MYR" ? "1" : p.fxRate || "1";
  const stamp = issueStamp(p.issuedAt);
  const lines = p.lines.map((l, n) =>
    compact({
      ID: v(String(n + 1)),
      InvoicedQuantity: v(l.quantity, l.unitCode ? { unitCode: l.unitCode } : {}),
      LineExtensionAmount: amount(l.net, currency),
      AllowanceCharge: l.discount
        ? [{ ChargeIndicator: v(false), AllowanceChargeReason: v("Discount"), Amount: amount(l.discount, currency) }]
        : undefined,
      TaxTotal: taxTotal([l.tax], currency, fx),
      Item: [
        {
          CommodityClassification: l.classes.map((c) => ({ ItemClassificationCode: v(c, { listID: "CLASS" }) })),
          Description: v(l.description),
        },
      ],
      Price: [{ PriceAmount: amount(l.unitPrice, currency) }],
      ItemPriceExtension: [{ Amount: amount(l.subtotal, currency) }],
    }),
  );
  // Document totals by tax category and rate.
  const groups = new Map();
  for (const l of p.lines) {
    const key = l.tax.category + ":" + l.tax.rate;
    const g = groups.get(key) || { ...l.tax, taxable: 0, tax: 0 };
    g.taxable += l.tax.taxable;
    g.tax += l.tax.tax;
    groups.set(key, g);
  }
  const net = p.lines.reduce((s, l) => s + l.net, 0),
    tax = p.lines.reduce((s, l) => s + l.tax.tax, 0);
  const invoice = compact({
    ID: v(p.number),
    IssueDate: v(stamp.date),
    IssueTime: v(stamp.time),
    InvoiceTypeCode: v(p.typeCode, { listVersionID: "1.0" }),
    DocumentCurrencyCode: v(currency),
    TaxCurrencyCode: v("MYR"),
    BillingReference: p.billing?.length
      ? p.billing.map((b) => ({ InvoiceDocumentReference: [{ ID: v(b.id), UUID: v(b.uuid) }] }))
      : undefined,
    AccountingSupplierParty: [{ Party: party(p.supplier, true) }],
    AccountingCustomerParty: [{ Party: party(p.buyer, false) }],
    TaxExchangeRate:
      currency === "MYR"
        ? undefined
        : [{ SourceCurrencyCode: v(currency), TargetCurrencyCode: v("MYR"), CalculationRate: v(Number(fx)) }],
    TaxTotal: taxTotal([...groups.values()], currency, fx),
    LegalMonetaryTotal: [
      {
        LineExtensionAmount: amount(net, currency),
        TaxExclusiveAmount: amount(net, currency),
        TaxInclusiveAmount: amount(net + tax, currency),
        PayableAmount: amount(net + tax, currency),
      },
    ],
    InvoiceLine: lines,
  });
  return { ...NAMESPACES, Invoice: [invoice] };
}

// ---- Keys and certificates ----
// PEM pasted into a one-line field loses its line breaks; rebuild each block.
export function normalizePem(text) {
  const blocks = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  for (const m of String(text || "").matchAll(re)) {
    const body = m[2].replace(/\s+/g, "");
    blocks.push(`-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g)?.join("\n") || ""}\n-----END ${m[1]}-----\n`);
  }
  return blocks;
}
export function signingMaterial({ key, cert, passphrase }) {
  const blocks = [...normalizePem(key), ...normalizePem(cert)];
  const keyPem = blocks.find((b) => /PRIVATE KEY-----/.test(b));
  const certPem = blocks.find((b) => b.startsWith("-----BEGIN CERTIFICATE-----"));
  if (!keyPem || !certPem)
    throw new AppError("Add both the signing private key and certificate (PEM) in Settings > Integration keys.", 409);
  let privateKey, certificate;
  try {
    privateKey = createPrivateKey(passphrase ? { key: keyPem, passphrase } : keyPem);
  } catch {
    throw new AppError("The signing private key could not be read. Use an unencrypted or PKCS#8 PEM key, with its passphrase if it has one.", 409);
  }
  try {
    certificate = new X509Certificate(certPem);
  } catch {
    throw new AppError("The signing certificate could not be read. Paste the PEM certificate from your certificate authority.", 409);
  }
  if (!certificate.checkPrivateKey(privateKey))
    throw new AppError("The signing private key does not belong to the certificate.", 409);
  return { privateKey, certificate };
}
// LHDN compares the issuer name literally and its signed samples use the
// certificate's own order (C, O, OU, E, CN) joined by ", ".
const DN_ORDER = ["C", "O", "OU", "E", "CN"];
export function distinguishedName(dn) {
  const rdns = String(dn)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      const key = line.slice(0, i).trim();
      return { key: /^(emailAddress|EMAIL)$/i.test(key) ? "E" : key, value: line.slice(i + 1).trim() };
    });
  const ordered = [
    ...DN_ORDER.flatMap((k) => rdns.filter((r) => r.key === k)),
    ...rdns.filter((r) => !DN_ORDER.includes(r.key)),
  ];
  return ordered.map((r) => `${r.key}=${r.value}`).join(", ");
}
export function certificateInfo(certificate) {
  return {
    digest: createHash("sha256").update(certificate.raw).digest("base64"),
    issuer: distinguishedName(certificate.issuer),
    subject: distinguishedName(certificate.subject),
    serial: BigInt("0x" + certificate.serialNumber).toString(10),
    base64: certificate.raw.toString("base64"),
    validTo: new Date(certificate.validTo).toISOString(),
    validFrom: new Date(certificate.validFrom).toISOString(),
  };
}

const sha256b64 = (s) => createHash("sha256").update(s).digest("base64");
// Document as it is digested: signature parts removed, version set to 1.1.
function prepared(doc) {
  const { UBLExtensions, Signature, ...body } = doc.Invoice[0];
  body.InvoiceTypeCode = body.InvoiceTypeCode.map((t) => ({ ...t, listVersionID: "1.1" }));
  return { ...doc, Invoice: [body] };
}
export function signDocument(doc, { privateKey, certificate }, signingTime = new Date()) {
  const unsigned = prepared(doc);
  const minified = JSON.stringify(unsigned);
  const docDigest = sha256b64(minified);
  const signatureValue = createSign("SHA256").update(minified).sign(privateKey, "base64");
  const cert = certificateInfo(certificate);
  const time = new Date(signingTime).toISOString().slice(0, 19) + "Z";
  const qualifying = {
    Target: "signature",
    SignedProperties: [
      {
        Id: PROPS_ID,
        SignedSignatureProperties: [
          {
            SigningTime: v(time),
            SigningCertificate: [
              {
                Cert: [
                  {
                    CertDigest: [{ DigestMethod: [{ _: "", Algorithm: DIGEST }], DigestValue: v(cert.digest) }],
                    IssuerSerial: [{ X509IssuerName: v(cert.issuer), X509SerialNumber: v(cert.serial) }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const propsDigest = sha256b64(JSON.stringify(qualifying));
  const extensions = [
    {
      UBLExtension: [
        {
          ExtensionURI: v(SIGNATURE_METHOD),
          ExtensionContent: [
            {
              UBLDocumentSignatures: [
                {
                  SignatureInformation: [
                    {
                      ID: v("urn:oasis:names:specification:ubl:signature:1"),
                      ReferencedSignatureID: v(SIGNATURE_ID),
                      Signature: [
                        {
                          Id: "signature",
                          Object: [{ QualifyingProperties: [qualifying] }],
                          KeyInfo: [
                            {
                              X509Data: [
                                {
                                  X509Certificate: v(cert.base64),
                                  X509SubjectName: v(cert.subject),
                                  X509IssuerSerial: [{ X509IssuerName: v(cert.issuer), X509SerialNumber: v(cert.serial) }],
                                },
                              ],
                            },
                          ],
                          SignatureValue: v(signatureValue),
                          SignedInfo: [
                            {
                              SignatureMethod: [{ _: "", Algorithm: RSA_SHA256 }],
                              Reference: [
                                { Type: PROPS_TYPE, URI: "#" + PROPS_ID, DigestMethod: [{ _: "", Algorithm: DIGEST }], DigestValue: v(propsDigest) },
                                { Type: "", URI: "", DigestMethod: [{ _: "", Algorithm: DIGEST }], DigestValue: v(docDigest) },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  const signed = {
    ...unsigned,
    Invoice: [
      {
        ...unsigned.Invoice[0],
        UBLExtensions: extensions,
        Signature: [{ ID: v(SIGNATURE_ID), SignatureMethod: v(SIGNATURE_METHOD) }],
      },
    ],
  };
  return { document: signed, json: JSON.stringify(signed), digests: { docDigest, propsDigest, certDigest: cert.digest, signatureValue, signingTime: time } };
}
// Recomputes both digests and checks the signature, as LHDN does on submission.
export function verifyDocument(input) {
  const doc = typeof input === "string" ? JSON.parse(input) : input;
  const sig = doc.Invoice?.[0]?.UBLExtensions?.[0]?.UBLExtension?.[0]?.ExtensionContent?.[0]?.UBLDocumentSignatures?.[0]
    ?.SignatureInformation?.[0]?.Signature?.[0];
  if (!sig) return { valid: false, reason: "No signature" };
  const [propsRef, docRef] = sig.SignedInfo[0].Reference;
  const minified = JSON.stringify(prepared(doc));
  const certificate = new X509Certificate(Buffer.from(sig.KeyInfo[0].X509Data[0].X509Certificate[0]._, "base64"));
  const documentDigest = docRef.DigestValue[0]._ === sha256b64(minified);
  const propertiesDigest = propsRef.DigestValue[0]._ === sha256b64(JSON.stringify(sig.Object[0].QualifyingProperties[0]));
  const signature = createVerify("SHA256").update(minified).verify(certificate.publicKey, sig.SignatureValue[0]._, "base64");
  const certDigest =
    sig.Object[0].QualifyingProperties[0].SignedProperties[0].SignedSignatureProperties[0].SigningCertificate[0].Cert[0].CertDigest[0]
      .DigestValue[0]._ === createHash("sha256").update(certificate.raw).digest("base64");
  return { valid: documentDigest && propertiesDigest && signature && certDigest, documentDigest, propertiesDigest, signature, certDigest };
}
// One entry of POST /api/v1.0/documentsubmissions/. The hash is over the raw
// document bytes (hex), not over the base64 text.
export function submissionEntry(json, codeNumber) {
  return {
    format: "JSON",
    document: Buffer.from(json, "utf8").toString("base64"),
    documentHash: createHash("sha256").update(json, "utf8").digest("hex"),
    codeNumber,
  };
}
