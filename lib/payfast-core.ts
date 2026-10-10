import { createHash } from "node:crypto";

// PayFast signing rules, matching PayFast's own SDK (payfast-php-sdk, lib/Auth.php
// and Notification.php). Kept free of server-only imports so it can be unit-tested.

// PHP urlencode(): spaces become "+", and everything except A-Z a-z 0-9 - _ . is %XX (uppercase).
export function phpUrlencode(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, "+");
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

// Checkout form fields, in the order PayFast documents them. The signature uses
// this order, skipping empty values, then the passphrase.
export const FORM_FIELD_ORDER = [
  "merchant_id", "merchant_key", "return_url", "cancel_url", "notify_url", "notify_method",
  "name_first", "name_last", "email_address", "cell_number", "m_payment_id", "amount", "item_name",
  "item_description", "custom_int1", "custom_int2", "custom_int3", "custom_int4", "custom_int5",
  "custom_str1", "custom_str2", "custom_str3", "custom_str4", "custom_str5", "email_confirmation",
  "confirmation_address", "currency", "payment_method", "subscription_type", "billing_date",
  "recurring_amount", "frequency", "cycles", "subscription_notify_email", "subscription_notify_webhook",
  "subscription_notify_buyer",
] as const;

export function formSignature(fields: Record<string, string>, passphrase: string) {
  const parts: string[] = [];
  for (const key of FORM_FIELD_ORDER) {
    const v = fields[key];
    if (v !== undefined && v !== "") parts.push(`${key}=${phpUrlencode(v.trim())}`);
  }
  if (passphrase) parts.push(`passphrase=${phpUrlencode(passphrase.trim())}`);
  return md5(parts.join("&"));
}

// Orders the fields for the form, so what we post is what we signed.
export function orderedFormFields(fields: Record<string, string>) {
  return FORM_FIELD_ORDER.filter((k) => fields[k] !== undefined && fields[k] !== "").map((k) => [k, fields[k].trim()] as const);
}

// ITN (payment notification): the posted fields in the order received, up to "signature".
export function itnParamString(pairs: [string, string][]) {
  const parts: string[] = [];
  for (const [k, v] of pairs) {
    if (k === "signature") break;
    parts.push(`${k}=${phpUrlencode(v)}`);
  }
  return parts.join("&");
}

export function validItnSignature(pairs: [string, string][], passphrase: string) {
  const given = pairs.find(([k]) => k === "signature")?.[1];
  if (!given) return false;
  const base = itnParamString(pairs);
  const expected = md5(passphrase ? `${base}&passphrase=${phpUrlencode(passphrase)}` : base);
  return expected === given;
}

// API requests (ad hoc charges): every header and body value, sorted by key, plus the passphrase.
export function apiSignature(data: Record<string, string | number>, passphrase: string) {
  const all: Record<string, string> = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  if (passphrase) all.passphrase = passphrase;
  return md5(
    Object.keys(all)
      .filter((k) => k !== "signature")
      .sort()
      .map((k) => `${k}=${phpUrlencode(all[k])}`)
      .join("&"),
  );
}

export const randString = (n: number) => n.toFixed(2);
