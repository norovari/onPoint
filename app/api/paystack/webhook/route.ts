import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { recordCardPayment, validWebhookSignature, verifyTransaction } from "@/lib/paystack";

// Set this URL as the webhook in the Paystack dashboard: https://<your site>/api/paystack/webhook
export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (!validWebhookSignature(raw, request.headers.get("x-paystack-signature"))) {
    return new NextResponse("Invalid signature", { status: 401 });
  }
  const event = JSON.parse(raw) as { event: string; data?: { reference?: string } };
  const reference = event.data?.reference;
  if (!reference) return NextResponse.json({ ok: true });
  const service = createServiceClient();
  try {
    if (event.event === "charge.success") {
      // Re-verify with Paystack rather than trusting the webhook body alone
      const tx = await verifyTransaction(reference);
      if (tx.status === "success") await recordCardPayment(service, tx);
    } else if (event.event === "charge.failed") {
      await service.rpc("billing_renewal_failed", { p_reference: reference });
    }
  } catch (e) {
    // References that are not OnPoint invoices are ignored
    console.error("Paystack webhook", (e as Error).message);
  }
  return NextResponse.json({ ok: true });
}
