import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Minimal Paystack client. Amounts are in cents (ZAR subunit).
const BASE = "https://api.paystack.co";
const secret = () => {
  const k = process.env.PAYSTACK_SECRET_KEY;
  if (!k) throw new Error("Card payments are not set up yet (PAYSTACK_SECRET_KEY).");
  return k;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secret()}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: unknown };
  if (!res.ok || body.status === false) throw new Error(body.message || `Paystack error ${res.status}`);
  return body.data as T;
}

export function initializeTransaction(input: { email: string; amountCents: number; reference: string; callbackUrl: string; metadata: Record<string, unknown> }) {
  return call<{ authorization_url: string; reference: string }>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      amount: String(input.amountCents),
      currency: "ZAR",
      reference: input.reference,
      callback_url: input.callbackUrl,
      channels: ["card"],
      metadata: JSON.stringify(input.metadata),
    }),
  });
}

export interface VerifiedTransaction {
  status: string; // "success" | "failed" | "abandoned" | ...
  reference: string;
  amount: number;
  currency: string;
  customer?: { email?: string; customer_code?: string };
  authorization?: { authorization_code?: string; reusable?: boolean };
}

export const verifyTransaction = (reference: string) =>
  call<VerifiedTransaction>(`/transaction/verify/${encodeURIComponent(reference)}`);

export function chargeAuthorization(input: { authorizationCode: string; email: string; amountCents: number; reference: string }) {
  return call<VerifiedTransaction>("/transaction/charge_authorization", {
    method: "POST",
    body: JSON.stringify({
      authorization_code: input.authorizationCode,
      email: input.email,
      amount: String(input.amountCents),
      currency: "ZAR",
      reference: input.reference,
    }),
  });
}

// Paystack signs webhook bodies with HMAC-SHA512 of the raw body using the secret key.
export function validWebhookSignature(rawBody: string, signature: string | null) {
  if (!signature) return false;
  const expected = createHmac("sha512", secret()).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Records a successful card payment against its invoice (idempotent).
export async function recordCardPayment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: any,
  tx: VerifiedTransaction,
) {
  const { data, error } = await service.rpc("billing_record_card_payment", {
    p_reference: tx.reference,
    p_amount_cents: tx.amount,
    p_currency: tx.currency,
    p_authorization: tx.authorization?.authorization_code ?? null,
    p_reusable: tx.authorization?.reusable ?? false,
    p_customer: tx.customer?.customer_code ?? null,
    p_email: tx.customer?.email ?? null,
  });
  if (error) throw new Error(error.message);
  return data;
}
