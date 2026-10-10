import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { chargeAuthorization, recordCardPayment } from "@/lib/paystack";

// Runs daily (vercel.json). Charges card subscriptions that are due, applying
// the launch discount for the first 3 months. Vercel sends CRON_SECRET as a bearer token.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorised", { status: 401 });
  }
  if (!process.env.PAYSTACK_SECRET_KEY) return NextResponse.json({ skipped: "card payments not set up" });

  const service = createServiceClient();
  const { data: due, error } = await service.rpc("billing_due_renewals");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: { business_id: string; outcome: string }[] = [];
  for (const d of (due ?? []) as { business_id: string; email: string; authorization_code: string }[]) {
    const { data: inv, error: invErr } = await service.rpc("billing_start_renewal", { p_business: d.business_id });
    if (invErr) { results.push({ business_id: d.business_id, outcome: invErr.message }); continue; }
    const invoice = inv as { reference: string; amount: number };
    try {
      const tx = await chargeAuthorization({
        authorizationCode: d.authorization_code,
        email: d.email,
        amountCents: Math.round(Number(invoice.amount) * 100),
        reference: invoice.reference,
      });
      if (tx.status === "success") {
        await recordCardPayment(service, tx);
        results.push({ business_id: d.business_id, outcome: "paid" });
      } else if (tx.status === "failed") {
        await service.rpc("billing_renewal_failed", { p_reference: invoice.reference });
        results.push({ business_id: d.business_id, outcome: "failed" });
      } else {
        results.push({ business_id: d.business_id, outcome: tx.status }); // webhook settles it later
      }
    } catch (e) {
      await service.rpc("billing_renewal_failed", { p_reference: invoice.reference });
      results.push({ business_id: d.business_id, outcome: (e as Error).message });
    }
  }
  return NextResponse.json({ charged: results.length, results });
}
