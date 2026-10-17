// DuitNow QR (PayNet) uses the EMVCo merchant-presented QR format: a list of
// ID (2 digits) + length (2 digits) + value fields, ending with a CRC-16
// checksum in field 63. Only the owner's static QR from the bank is accepted;
// no amount is ever added, the client types it in their banking app.
import { check } from "./domain.mjs";
// CRC-16/CCITT-FALSE (polynomial 0x1021, initial 0xFFFF), as EMVCo requires.
export function crc16(text) {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
// Splits a TLV string into [{ id, value }]; throws on a broken structure.
export function parseEmv(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const id = text.slice(i, i + 2),
      len = text.slice(i + 2, i + 4);
    check(/^\d\d$/.test(id) && /^\d\d$/.test(len), "This is not a valid QR payload (broken field structure).");
    const value = text.slice(i + 4, i + 4 + Number(len));
    check(value.length === Number(len), "This is not a valid QR payload (a field is cut short).");
    out.push({ id, value });
    i += 4 + Number(len);
  }
  return out;
}
// Validates a pasted static DuitNow / EMVCo payload and returns its details.
export function validateDuitNow(input) {
  check(typeof input === "string", "Paste the QR text from your bank.");
  const payload = input.replace(/[\r\n]+/g, "").trim();
  check(payload.length >= 30 && payload.length <= 512, "The QR text should be 30 to 512 characters.");
  check(!/[\u0000-\u001f\u007f]/.test(payload), "The QR text has invalid characters.");
  const fields = parseEmv(payload);
  const get = (id) => fields.find((f) => f.id === id)?.value;
  check(fields[0]?.id === "00" && fields[0].value === "01", "This is not an EMVCo payment QR (it must start with 000201).");
  const last = fields[fields.length - 1];
  check(last?.id === "63" && last.value.length === 4, "The QR text has no checksum (field 63) at the end.");
  check(
    crc16(payload.slice(0, -4)) === last.value.toUpperCase(),
    "The QR checksum does not match. Copy the whole QR text again.",
  );
  check(get("01") !== "12", "This QR is dynamic (for one payment only). Use the static DuitNow QR from your bank.");
  check(get("54") === undefined, "This QR has a fixed amount. Use the static DuitNow QR without an amount.");
  check(get("53") === "458", "This QR is not in Malaysian ringgit (currency 458).");
  check(get("58") === "MY", "This QR is not a Malaysian QR (country MY).");
  const accounts = fields.filter((f) => Number(f.id) >= 26 && Number(f.id) <= 51);
  check(accounts.length, "This QR has no merchant account information.");
  const merchant = get("59");
  check(merchant, "This QR has no merchant name.");
  // PayNet's application ID (RID A000000615) marks a DuitNow merchant account.
  const duitnow = accounts.some((a) => {
    try {
      return parseEmv(a.value).some((s) => s.id === "00" && /A000000615/i.test(s.value));
    } catch {
      return false;
    }
  });
  return {
    payload: payload.slice(0, -4) + last.value.toUpperCase(),
    merchant: merchant.slice(0, 100),
    city: (get("60") || "").slice(0, 60),
    duitnow,
  };
}
