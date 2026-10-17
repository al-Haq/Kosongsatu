import test from "node:test";
import assert from "node:assert/strict";
import { parseAmount, parseDateText, parseQuickText, matchClient, matchService, aiParse, whatsappReply } from "../server/platform-quick.mjs";

const REF = "2026-10-17";
const clients = [
  { id: "c1", name: "ABC Sdn Bhd", terms: 30 },
  { id: "c2", name: "Meranti Digital (Demo)", terms: 14 },
  { id: "c3", name: "Rimba Retail (Demo)", terms: 14 },
  { id: "c4", name: "Bayu Design (Demo)", terms: 7 },
  { id: "c5", name: "Old Client Sdn Bhd", terms: 14, archived: 1 },
];
const services = [
  { id: "s1", name: "Managed maintenance", rate: 75000, unit: "Month", tax_rate: 8 },
  { id: "s2", name: "Cloud setup", rate: 80000, unit: "Project", tax_rate: 0 },
  { id: "s3", name: "Technical consulting", rate: 20000, unit: "Hour", tax_rate: 0 },
];
const parse = (text, extra = {}) => parseQuickText(text, { clients, services, settings: { sstNumber: "W10-1808-32000001" }, ref: REF, ...extra });
const lines = (d) => d.items.map((i) => [i.description, i.quantity, i.rate]);

test("amounts in common Malaysian formats", () => {
  const cases = {
    "RM1,500": 150000,
    "RM 1500.00": 150000,
    "rm1500": 150000,
    "1.5k": 150000,
    "RM2.5K": 250000,
    "3 ribu": 300000,
    "5rb": 500000,
    "RM1.2j": 120000000,
    "RM1.2m": 120000000,
    "1500 ringgit": 150000,
    "MYR 99.90": 9990,
    "1,234,567.89": 123456789,
    "0.50": 50,
  };
  for (const [raw, sen] of Object.entries(cases)) assert.equal(parseAmount(raw), sen, raw);
  for (const bad of ["", "RM", "1,5", "1.234", "12,34", "abc", "1.5m", "-5", "RM999,999,999.99"]) assert.equal(parseAmount(bad), null, bad);
  assert.equal(parseAmount(12.5), 1250);
});

test("dates in day-first and written forms, next occurrence without a year", () => {
  assert.equal(parseDateText("2026-11-15", REF), "2026-11-15");
  assert.equal(parseDateText("15/11/2026", REF), "2026-11-15");
  assert.equal(parseDateText("5-1-27", REF), "2027-01-05");
  assert.equal(parseDateText("15 Nov", REF), "2026-11-15");
  assert.equal(parseDateText("1 Okt", REF), "2027-10-01");
  assert.equal(parseDateText("Disember 3, 2026", REF), "2026-12-03");
  assert.equal(parseDateText("31/02/2026", REF), null);
  assert.equal(parseDateText("next week", REF), null);
});

test("the roadmap examples, in Malay and English", () => {
  let d = parse("Invois ABC Sdn Bhd, maintenance Oktober, RM1,500");
  assert.equal(d.kind, "invoice");
  assert.equal(d.client.id, "c1");
  assert.deepEqual(lines(d), [["Maintenance - Oktober 2026", "1", "1500.00"]]);
  assert.equal(d.items[0].service_id, "s1", "matched the catalog service");
  assert.equal(d.items[0].tax_rate, 8, "SST from the service");
  assert.equal(d.due_date, "2026-11-16", "client's 30-day terms");
  assert.equal(d.understood, true);

  d = parse("Quote Meranti Digital: 3 days onsite support at RM800/day, due in 30 days");
  assert.equal(d.kind, "quote");
  assert.equal(d.client.id, "c2");
  assert.deepEqual(lines(d), [["Onsite support", "3", "800.00"]]);
  assert.equal(d.items[0].unit, "Day");
  assert.equal(d.due_date, "2026-11-16");
  assert.equal(d.due_source, "text");
});

test("many phrasings of quantity, rate and amount", () => {
  const cases = [
    ["Invoice Rimba Retail for website hosting 12 months @ RM50 per month", [["Website hosting", "12", "50.00"]]],
    ["Bil ABC: 2 x laptop repair @ RM150", [["Laptop repair", "2", "150.00"]]],
    ["Invoice ABC laptop repair x2 RM150 each", [["Laptop repair", "2", "150.00"]]],
    ["Invoice ABC Sdn Bhd consulting 10 hours at RM200/hour", [["Consulting", "10", "200.00"]]],
    ["Invois ABC 5 jam konsultasi, jumlah RM1000", [["Konsultasi", "5", "200.00"]]],
    ["Invois ABC: sokongan tiga hari RM600 sehari", [["Sokongan", "3", "600.00"]]],
    ["Invoice ABC maintenance 1500", [["Maintenance", "1", "1500.00"]]],
    ["Invoice ABC RM1500 for maintenance", [["Maintenance", "1", "1500.00"]]],
    ["Sebut harga Bayu Design: reka bentuk logo RM2.5k", [["Reka bentuk logo", "1", "2500.00"]]],
    ["inv meranti - cloud setup 1.5k + maintenance oct rm750", [["Cloud setup", "1", "1500.00"], ["Maintenance - October 2026", "1", "750.00"]]],
    ["Invoice ABC: server setup RM2,000; training 2 sessions at RM350", [["Server setup", "1", "2000.00"], ["Training", "2", "350.00"]]],
    ["Invoice ABC 24/7 monitoring RM300", [["24/7 monitoring", "1", "300.00"]]],
    ["Invoice ABC 3 days support RM1000", [["3 days support", "1", "1000.00"]]],
    ["Invoice ABC 3 days onsite support at RM800/day, total RM2,400", [["Onsite support", "3", "800.00"]]],
  ];
  for (const [text, expected] of cases) assert.deepEqual(lines(parse(text)), expected, text);
  // A total that is not a whole number of sen per unit stays a single line.
  assert.match(parse("Invoice ABC 3 days support RM1000").warnings.join(" "), /^$|./);
  // A total read for several units is explained.
  assert.match(parse("Invois ABC 5 jam konsultasi, jumlah RM1000").warnings.join(" "), /total for 5 hours/);
  // A mismatching total is flagged.
  assert.match(parse("Invoice ABC 3 days at RM800/day, total RM2,000").warnings.join(" "), /does not match/);
});

test("periods: months in both languages, ranges, relative months and quarters", () => {
  const desc = (t) => parse(t).items[0].description;
  assert.equal(desc("Invois ABC maintenance bulan Oktober RM750"), "Maintenance - Oktober 2026");
  assert.equal(desc("Invoice ABC maintenance for October RM750"), "Maintenance - October 2026");
  assert.equal(desc("Invoice ABC maintenance Dec 2025 RM750"), "Maintenance - December 2025");
  assert.equal(desc("Invoice ABC maintenance january RM750"), "Maintenance - January 2027", "nearest year");
  assert.equal(desc("Invois ABC penyelenggaraan bulan lepas RM750"), "Penyelenggaraan - September 2026");
  assert.equal(desc("Invoice ABC hosting next month RM50"), "Hosting - November 2026");
  assert.equal(desc("Invoice ABC retainer Q3 RM9000"), "Retainer - Q3 2026");
  assert.equal(desc("Invois ABC sokongan Okt-Dis RM900"), "Sokongan - Oktober–Disember 2026");
  // "Mac" (an Apple Mac) is not March unless a year or "bulan" says so.
  assert.equal(desc("Invoice ABC Mac mini repair RM300"), "Mac mini repair");
  assert.equal(desc("Invois ABC servis bulan Mac RM300"), "Servis - Mac 2027");
  // A month in its own part of the text belongs to the single line.
  assert.equal(desc("Invois ABC, maintenance, Oktober, RM1,500"), "Maintenance - Oktober 2026");
});

test("due terms and dates in Malay and English", () => {
  const due = (t) => parse(t).due_date;
  assert.equal(due("Invoice ABC setup RM500 net 7"), "2026-10-24");
  assert.equal(due("Invoice ABC setup RM500, payment terms 45 days"), "2026-12-01");
  assert.equal(due("Invoice ABC setup RM500 due within 2 weeks"), "2026-10-31");
  assert.equal(due("Invois ABC setup RM500 tempoh 14 hari"), "2026-10-31");
  assert.equal(due("Invois ABC setup RM500 bayar dalam 7 hari"), "2026-10-24");
  assert.equal(due("Invois ABC setup RM500, 60 hari kredit"), "2026-12-16");
  assert.equal(due("Invoice ABC setup RM500 due 15/11/2026"), "2026-11-15");
  assert.equal(due("Invoice ABC setup RM500 due by 20 Nov"), "2026-11-20");
  assert.equal(due("Invois ABC setup RM500 perlu dibayar sebelum 30/11/2026"), "2026-11-30");
  assert.equal(due("Quote ABC setup RM500 valid until 1 Dec 2026"), "2026-12-01");
  assert.equal(due("Sebut harga ABC setup RM500 sah 14 hari"), "2026-10-31");
  assert.equal(due("Invoice ABC setup RM500 due on receipt"), "2026-10-17");
  assert.equal(due("Invois ABC setup RM500 hujung bulan"), "2026-10-31");
  assert.equal(due("Invoice Bayu Design setup RM500"), "2026-10-24", "client terms");
  const past = parse("Invoice ABC setup RM500 due 1/1/2026");
  assert.equal(past.due_date, "2026-11-16");
  assert.match(past.warnings.join(" "), /before the issue date/);
  assert.equal(parse("Invoice ABC setup RM500 dated 1/10/2026").issue_date, "2026-10-01");
});

test("client matching: fuzzy, partial, ambiguous and unknown", () => {
  assert.equal(parse("Invois Merenti Digital setup RM500").client.id, "c2", "typo");
  assert.equal(parse("Invois Meranti Dig setup RM500").client.id, "c2", "abbreviation");
  assert.equal(parse("invoice abc sdn. bhd. setup rm500").client.id, "c1", "case and dots");
  assert.equal(parse("Invois maintenance Oktober untuk ABC Sdn Bhd RM1500").client.id, "c1", "client after the description");
  assert.deepEqual(lines(parse("Invois maintenance Oktober untuk ABC Sdn Bhd RM1500")), [["Maintenance - Oktober 2026", "1", "1500.00"]]);
  const partial = parse("Quote meranti, setup RM500");
  assert.equal(partial.client.id, "c2");
  assert.match(partial.warnings[0], /Matched “meranti”/);
  const more = [...clients, { id: "c6", name: "Meranti Holdings Sdn Bhd", terms: 14 }];
  const amb = parse("Quote Meranti: setup RM500", { clients: more });
  assert.equal(amb.client, undefined);
  assert.deepEqual(amb.clientChoices.map((c) => c.id).sort(), ["c2", "c6"]);
  assert.deepEqual(lines(amb), [["Setup", "1", "500.00"]], "lines still parsed");
  assert.equal(parse("Quote Meranti Holdings: setup RM500", { clients: more }).client.id, "c6", "full name wins");
  const abc = [...clients, { id: "c7", name: "ABC Trading", terms: 14 }];
  const similar = parse("Invoice ABC setup RM500", { clients: abc });
  assert.equal(similar.client.id, "c1", "the client whose name is exactly ABC");
  assert.deepEqual(similar.clientChoices.map((c) => c.id), ["c1", "c7"], "the other ABC stays a choice");
  assert.match(similar.warnings.join(" "), /Also similar: ABC Trading/);
  assert.equal(parse("Invoice ABC Trading setup RM500", { clients: abc }).client.id, "c7");
  // Archived clients are never matched.
  assert.equal(parse("Invoice Old Client setup RM500").client, undefined);
  const unknown = parse("Invoice Syarikat Baru Enterprise, setup RM500");
  assert.equal(unknown.client, undefined);
  assert.equal(unknown.clientQuery, "Syarikat Baru Enterprise");
  assert.deepEqual(lines(unknown), [["Setup", "1", "500.00"]]);
  // Words that are clearly a description are not taken as a client name.
  const noClient = parse("Invois maintenance Oktober, RM1500");
  assert.equal(noClient.clientQuery, "");
  assert.equal(noClient.items[0].description, "Maintenance - Oktober 2026");
  assert.equal(matchClient("nothing here", clients).status, "none");
});

test("services: synonyms, catalog rate when no amount and SST rules", () => {
  assert.equal(matchService("penyelenggaraan", services).id, "s1");
  assert.equal(matchService("consulting", services).id, "s3");
  assert.equal(matchService("website hosting", services), null);
  const rate = parse("Invoice ABC managed maintenance Oktober");
  assert.deepEqual(lines(rate), [["Managed maintenance - Oktober 2026", "1", "750.00"]]);
  assert.match(rate.warnings.join(" "), /Used the Managed maintenance rate/);
  const sst = parse("Invoice ABC setup RM500 + SST 6%");
  assert.equal(sst.items[0].tax_rate, 6);
  assert.equal(parse("Invoice ABC maintenance RM750 tanpa SST").items[0].tax_rate, 0);
  assert.match(parse("Invoice ABC setup RM500 SST 7%").warnings.join(" "), /not a Malaysian SST rate/);
  const noReg = parseQuickText("Invoice ABC maintenance RM750", { clients, services, settings: {}, ref: REF });
  assert.equal(noReg.items[0].tax_rate, 0, "no SST without a registration number");
  assert.match(noReg.warnings.join(" "), /SST registration number/);
});

test("discounts and notes", () => {
  const d = parse("Invoice ABC setup RM1,000 + training RM500, discount 10%, note: PO 4500012345");
  assert.equal(d.discount, "150.00");
  assert.equal(d.notes, "PO 4500012345");
  assert.equal(parse("Invois ABC setup RM1000 diskaun RM100").discount, "100.00");
  assert.equal(parse("Invoice ABC setup RM1000, 5% off").discount, "50.00");
  assert.match(parse("Invoice ABC setup RM100 discount RM500").warnings.join(" "), /larger than the subtotal/);
});

test("requests the parser cannot read are reported, not guessed", () => {
  const d = parse("Invoice ABC for the usual work");
  assert.equal(d.understood, false);
  assert.ok(d.items.every((i) => i.needs_rate));
  assert.equal(parse("hello there").understood, false);
  assert.throws(() => parse("x"), /Type what to bill/);
  assert.throws(() => parse("a".repeat(601)), /600 characters/);
  // An amount with no description gets a placeholder and a warning.
  const bare = parse("Invoice ABC RM1500");
  assert.deepEqual(lines(bare), [["Services", "1", "1500.00"]]);
  assert.match(bare.warnings.join(" "), /Add a description/);
  assert.equal(parse("Invois ABC RM1500").items[0].description, "Perkhidmatan");
  // Keyword detection.
  assert.equal(parse("Please create an invoice for ABC: setup RM500").kind, "invoice");
  assert.equal(parse("Buat sebut harga untuk ABC, setup RM500").kind, "quote");
  assert.equal(parse("ABC setup RM500").explicitKind, false);
});

test("the AI model reply is validated and re-matched", async () => {
  const reply = (content, status = 200) => async (url, init) => {
    reply.calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  };
  reply.calls = [];
  const config = { base: "https://ai.example/v1", model: "test-model", key: "k" };
  const d = await aiParse(
    { config, fetcher: reply('Here: {"kind":"quote","client":"Meranti Digital","lines":[{"description":"Usual monthly work","quantity":2,"rate":"1,250"}],"due_days":21}') },
    "Quote Meranti for the usual work, two months",
    { clients, services, settings: {}, ref: REF },
  );
  assert.equal(d.kind, "quote");
  assert.equal(d.client.id, "c2");
  assert.deepEqual(lines(d), [["Usual monthly work", "2", "1250.00"]]);
  assert.equal(d.due_date, "2026-11-07");
  assert.equal(d.understood, true);
  const sent = reply.calls[0].body;
  assert.equal(sent.model, "test-model");
  assert.ok(!JSON.stringify(sent).includes("c2"), "no record ids are sent");
  assert.ok(!JSON.stringify(sent).includes("Old Client"), "archived clients are not sent");
  await assert.rejects(aiParse({ config, fetcher: reply("not json") }, "x y z", { clients }), /could not be read/);
  await assert.rejects(aiParse({ config, fetcher: reply("{}", 500) }, "x y z", { clients }), /rejected/);
  await assert.rejects(aiParse({ config, fetcher: reply('{"lines":[]}') }, "x y z", { clients }), /could not be read/);
  await assert.rejects(aiParse({ config: null, fetcher: reply("{}") }, "x y z", { clients }), /No AI model/);
  const none = await aiParse({ config, fetcher: reply('{"lines":[{"description":"Work","rate":null}]}') }, "x y z", { clients, services });
  assert.equal(none.understood, false);
});

test("WhatsApp replies follow the request language", () => {
  const ms = { language: "ms", kind: "invoice", client: { name: "ABC Sdn Bhd" }, total: 150000 };
  assert.match(whatsappReply(ms, "saved", "https://x/#/document/1"), /^Invois draf untuk ABC Sdn Bhd \(RM1500\.00\).*https:\/\/x/);
  assert.match(whatsappReply({ ...ms, language: "en" }, "saved", "L"), /^Draft invoice for ABC/);
  assert.match(whatsappReply({ language: "en", clientChoices: [{ name: "A" }, { name: "B" }] }, "ambiguous"), /1\) A 2\) B/);
  assert.match(whatsappReply({ language: "ms" }, "unknown"), /tidak faham/);
});
