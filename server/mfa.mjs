import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { check, hash, now } from "./domain.mjs";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) out += alphabet[(value >>> (bits -= 5)) & 31];
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decode(secret) {
  let bits = 0,
    value = 0,
    out = [];
  for (const c of secret) {
    const n = alphabet.indexOf(c);
    check(n >= 0, "Invalid authenticator secret.");
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) out.push((value >>> (bits -= 8)) & 255);
  }
  return Buffer.from(out);
}
export function totp(secret, seconds = Date.now() / 1000, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const digest = createHmac("sha1", decode(secret)).update(counter).digest();
  const offset = digest[19] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(value).padStart(digits, "0");
}
export function verifyTotp(
  secret,
  code,
  lastStep = -1,
  seconds = Date.now() / 1000,
) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(seconds / 30);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate <= lastStep) continue;
    if (
      timingSafeEqual(
        Buffer.from(code),
        Buffer.from(totp(secret, candidate * 30)),
      )
    )
      return candidate;
  }
  return null;
}
export function readKey(value, label = "Encryption key") {
  check(
    typeof value === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value),
    `${label} must be exactly 32 bytes encoded as base64.`,
  );
  const key = Buffer.from(value, "base64");
  check(key.length === 32, `${label} must be 32 bytes.`);
  return key;
}
export function loadMfaKey(path, required = false) {
  if (process.env.MFA_ENCRYPTION_KEY)
    return readKey(process.env.MFA_ENCRYPTION_KEY, "MFA_ENCRYPTION_KEY");
  if (path === ":memory:") return randomBytes(32);
  const filename = path + ".mfa-key";
  if (!existsSync(filename)) {
    check(
      !required,
      "Restore the original MFA key file or MFA_ENCRYPTION_KEY before starting this database. Use console recovery only if the key is lost.",
    );
    try {
      writeFileSync(filename, randomBytes(32), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  const key = readFileSync(filename);
  check(key.length === 32, "Stored MFA key is invalid.");
  chmodSync(filename, 0o600);
  return key;
}
export function encrypt(data, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.isBuffer(data) ? data : Buffer.from(data)),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from("NWL2"), iv, cipher.getAuthTag(), body]);
}
export function decrypt(data, key) {
  data = Buffer.from(data);
  check(
    data.subarray(0, 4).toString() === "NWL2" && data.length >= 32,
    "Invalid encrypted data.",
  );
  const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(4, 16));
  cipher.setAuthTag(data.subarray(16, 32));
  return Buffer.concat([cipher.update(data.subarray(32)), cipher.final()]);
}
const seal = (secret, key) => encrypt(secret, key).toString("base64");
const unseal = (secret, key) =>
  decrypt(Buffer.from(secret, "base64"), key).toString();
export function mfaStatus(store, ownerId) {
  const owner = store.db
    .prepare("SELECT mfa_secret FROM owners WHERE id=?")
    .get(ownerId);
  return {
    enabled: !!owner?.mfa_secret,
    recoveryRemaining: store.db
      .prepare(
        "SELECT count(*) n FROM recovery_codes WHERE owner_id=? AND used=0",
      )
      .get(ownerId).n,
  };
}
export function beginMfa(store, ownerId) {
  const owner = store.db
    .prepare("SELECT * FROM owners WHERE id=?")
    .get(ownerId);
  check(
    owner && !owner.mfa_secret,
    "MFA is already enabled. Disable it with verification before replacing it.",
  );
  const secret = base32(randomBytes(20));
  store.db
    .prepare("UPDATE owners SET mfa_pending=?,mfa_pending_expires=? WHERE id=?")
    .run(seal(secret, store.mfaKey), Date.now() + 600000, ownerId);
  return {
    secret,
    uri: `otpauth://totp/${encodeURIComponent("Nawlogic:" + owner.email)}?secret=${secret}&issuer=Nawlogic&algorithm=SHA1&digits=6&period=30`,
  };
}
export function enableMfa(store, ownerId, code, keepSession) {
  return store.tx(() => {
    const owner = store.db
      .prepare("SELECT * FROM owners WHERE id=?")
      .get(ownerId);
    check(
      owner &&
        !owner.mfa_secret &&
        owner.mfa_pending &&
        owner.mfa_pending_expires > Date.now(),
      "Authenticator setup expired. Start again.",
    );
    const step = verifyTotp(unseal(owner.mfa_pending, store.mfaKey), code);
    check(step !== null, "Authenticator code is invalid.");
    store.db
      .prepare(
        "UPDATE owners SET mfa_secret=mfa_pending,mfa_pending=NULL,mfa_pending_expires=NULL,mfa_step=? WHERE id=?",
      )
      .run(step, ownerId);
    store.db
      .prepare("DELETE FROM recovery_codes WHERE owner_id=?")
      .run(ownerId);
    const codes = Array.from({ length: 10 }, () =>
      randomBytes(8).toString("hex").toUpperCase(),
    );
    for (const code of codes)
      store.db
        .prepare("INSERT INTO recovery_codes(owner_id,hash) VALUES(?,?)")
        .run(ownerId, hash(code));
    store.db
      .prepare("DELETE FROM sessions WHERE owner_id=? AND hash!=?")
      .run(ownerId, keepSession || "");
    store.audit(
      "mfa.enabled",
      String(ownerId),
      "Recovery codes generated; other sessions revoked.",
    );
    return { codes: codes.map((c) => c.match(/.{4}/g).join("-")) };
  });
}
export function verifySecondFactor(store, ownerId, code) {
  return store.tx(() => {
    const owner = store.db
      .prepare("SELECT * FROM owners WHERE id=?")
      .get(ownerId);
    if (!owner?.mfa_secret) return true;
    if (typeof code !== "string") return false;
    const normalized = code.trim().toUpperCase().replaceAll("-", "");
    if (/^[A-F0-9]{16}$/.test(normalized)) {
      const changed = store.db
        .prepare(
          "UPDATE recovery_codes SET used=1 WHERE owner_id=? AND hash=? AND used=0",
        )
        .run(ownerId, hash(normalized));
      if (changed.changes) {
        store.audit("mfa.recovery_code.used", String(ownerId));
        return true;
      }
      return false;
    }
    const step = verifyTotp(
      unseal(owner.mfa_secret, store.mfaKey),
      code.trim(),
      owner.mfa_step,
    );
    if (step === null) return false;
    store.db
      .prepare("UPDATE owners SET mfa_step=? WHERE id=?")
      .run(step, ownerId);
    return true;
  });
}
export function disableMfa(store, ownerId, keepSession) {
  store.tx(() => {
    store.db
      .prepare(
        "UPDATE owners SET mfa_secret=NULL,mfa_pending=NULL,mfa_pending_expires=NULL,mfa_step=-1 WHERE id=?",
      )
      .run(ownerId);
    store.db
      .prepare("DELETE FROM recovery_codes WHERE owner_id=?")
      .run(ownerId);
    store.db
      .prepare("DELETE FROM sessions WHERE owner_id=? AND hash!=?")
      .run(ownerId, keepSession || "");
    store.audit("mfa.disabled", String(ownerId), "Other sessions revoked.");
  });
}
