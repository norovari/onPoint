import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { chargeToken, payfastConfigured } from "@/lib/payfast";
import { planName } from "@/lib/plans";

// Runs daily (vercel.json). Charges saved cards for subscriptions that are due,
// applying the launch discount for the first 3 months. The result arrives from
// PayFast at /api/payfast/notify. Vercel sends CRON_SECRET as a bearer token.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorised", { status: 401 });
  }
  if (!payfastConfigured()) return NextResponse.json({ skipped: "card payments not set up" });

  const service = createServiceClient();
  const { data: due, error } = await service.rpc("billing_due_renewals");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: { business_id: string; outcome: string }[] = [];
  for (const d of (due ?? []) as { business_id: string; plan: string; authorization_code: string }[]) {
    const { data: inv, error: invErr } = await service.rpc("billing_start_renewal", { p_business: d.business_id });
    if (invErr) { results.push({ business_id: d.business_id, outcome: invErr.message }); continue; }
    const payment = inv as { reference: string; amount: number };
    try {
      await chargeToken({
        token: d.authorization_code,
        amountCents: Math.round(Number(payment.amount) * 100),
        paymentReference: payment.reference,
        itemName: `OnPoint ${planName(d.plan)} (monthly)`,
      });
      results.push({ business_id: d.business_id, outcome: "submitted" });
    } catch (e) {
      await service.rpc("billing_renewal_failed", { p_reference: payment.reference });
      results.push({ business_id: d.business_id, outcome: (e as Error).message });
    }
  }
  return NextResponse.json({ charged: results.length, results });
}
