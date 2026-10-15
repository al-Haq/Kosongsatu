import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { hash, check, text } from "./domain.mjs";
const derive = promisify(scrypt);
export async function passwordHash(password) {
  check(
    typeof password === "string" &&
      password.length >= 12 &&
      password.length <= 256,
    "Password must contain 12 to 256 characters.",
  );
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, 64, {
    N: 32768,
    maxmem: 64 * 1024 * 1024,
  });
  return `${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || password.length > 256) return false;
  const [salt, hex] = stored.split(":");
  const key = await derive(password, salt, 64, {
    N: 32768,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(key, Buffer.from(hex, "hex"));
}
export async function createOwner(store, email, password) {
  email = text(email, 160, true).toLowerCase();
  check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "Valid email required.");
  check(
    !store.db.prepare("SELECT id FROM owners LIMIT 1").get(),
    "An owner already exists.",
  );
  const p = await passwordHash(password);
  store.db
    .prepare("INSERT INTO owners(email,password) VALUES(?,?)")
    .run(email, p);
}
export function sessionFrom(req, store) {
  const cookies = req.headers.cookie || "";
  const token = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("nawlogic_session="))
    ?.slice(17);
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  return (
    store.db
      .prepare(
        "SELECT s.*,o.email FROM sessions s JOIN owners o ON o.id=s.owner_id WHERE hash=? AND expires>?",
      )
      .get(hash(token), Date.now()) || null
  );
}
export function createSession(store, ownerId) {
  const token = randomBytes(32).toString("base64url"),
    csrf = randomBytes(24).toString("base64url");
  store.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
  store.db
    .prepare("INSERT INTO sessions(hash,owner_id,csrf,expires) VALUES(?,?,?,?)")
    .run(hash(token), ownerId, csrf, Date.now() + 8 * 3600000);
  return { token, csrf };
}
export function cookie(token, secure = false, clear = false) {
  return `nawlogic_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 28800}${secure ? "; Secure" : ""}`;
}
