import "server-only";
import { apiSignature, formSignature, itnParamString, orderedFormFields, randString, validItnSignature } from "@/lib/payfast-core";

// PayFast card checkout with tokenisation: the first payment is made on PayFast's
// page and saves the card as a token; later months are charged with that token
// ("ad hoc" charges) by the daily billing job, so the launch discount and plan
// changes always charge the right amount.

const cfg = () => {
  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
  const passphrase = process.env.PAYFAST_PASSPHRASE ?? "";
  if (!merchantId || !merchantKey || !passphrase) {
    throw new Error("Card payments are not set up yet (PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE).");
  }
  const sandbox = process.env.PAYFAST_SANDBOX === "true";
  return {
    merchantId, merchantKey, passphrase, sandbox,
    processUrl: sandbox ? "https://sandbox.payfast.co.za/eng/process" : "https://www.payfast.co.za/eng/process",
    validateUrl: sandbox ? "https://sandbox.payfast.co.za/eng/query/validate" : "https://www.payfast.co.za/eng/query/validate",
  };
};

export const payfastConfigured = () =>
  Boolean(process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_MERCHANT_KEY && process.env.PAYFAST_PASSPHRASE);

export function checkoutForm(input: {
  siteUrl: string; email: string; firstName?: string; paymentReference: string; customerReference: string;
  amount: number; itemName: string; businessName: string;
}) {
  const c = cfg();
  const fields: Record<string, string> = {
    merchant_id: c.merchantId,
    merchant_key: c.merchantKey,
    return_url: `${input.siteUrl}/billing?check=1`,
    cancel_url: `${input.siteUrl}/billing?cancelled=1`,
    notify_url: `${input.siteUrl}/api/payfast/notify`,
    name_first: (input.firstName ?? "").slice(0, 100),
    email_address: input.email,
    m_payment_id: input.paymentReference,
    amount: randString(input.amount),
    item_name: input.itemName.slice(0, 100),
    item_description: `${input.businessName} · ${input.customerReference}`.slice(0, 255),
    custom_str1: input.customerReference,
    payment_method: "cc",
    subscription_type: "2", // tokenisation: save the card for monthly charges
  };
  const ordered = orderedFormFields(fields);
  return { action: c.processUrl, fields: [...ordered, ["signature", formSignature(fields, c.passphrase)] as const] };
}

// Checks a payment notification: our signature, our merchant, and PayFast's own confirmation.
export async function verifyItn(rawBody: string) {
  const c = cfg();
  const pairs = [...new URLSearchParams(rawBody).entries()] as [string, string][];
  const data = Object.fromEntries(pairs);
  if (!validItnSignature(pairs, c.passphrase)) return { ok: false as const, reason: "signature" };
  if (data.merchant_id !== c.merchantId) return { ok: false as const, reason: "merchant" };
  const res = await fetch(c.validateUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: itnParamString(pairs),
    cache: "no-store",
  });
  const text = (await res.text()).trim();
  if (text !== "VALID") return { ok: false as const, reason: "not confirmed by PayFast" };
  return { ok: true as const, data };
}

// Charges a saved card. The result arrives by notification (ITN) with the same m_payment_id.
export async function chargeToken(input: { token: string; amountCents: number; paymentReference: string; itemName: string }) {
  const c = cfg();
  const body = { amount: input.amountCents, item_name: input.itemName.slice(0, 100), m_payment_id: input.paymentReference };
  const headers = { "merchant-id": c.merchantId, version: "v1", timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00") };
  const signature = apiSignature({ ...headers, ...body }, c.passphrase);
  const url = `https://api.payfast.co.za/subscriptions/${encodeURIComponent(input.token)}/adhoc${c.sandbox ? "?testing=true" : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, signature, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string; data?: { response?: unknown; message?: string } };
  if (!res.ok || json.status !== "success") throw new Error(json.data?.message || `PayFast error ${res.status}`);
  return json;
}
