import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Staff PINs: 4–6 digits, hashed with scrypt and a random salt.
export const PIN_RE = /^\d{4,6}$/;
export const MAX_TRIES = 5;
export const LOCK_MINUTES = 15;

export function hashPin(pin: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function pinMatches(pin: string, stored: string) {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const a = Buffer.from(hash, "hex"), b = scryptSync(pin, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}
