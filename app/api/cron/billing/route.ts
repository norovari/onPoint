import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { chargeToken, payfastConfigured } from "@/lib/payfast";
import { planName } from "@/lib/plans";
import { sendTrialEmail } from "@/lib/notify";

// Runs daily at 08:00 SA time (vercel.json). Sends the trial emails, then charges saved cards for subscriptions that are due,
// applying the launch discount for the first 3 months. The result arrives from
// PayFast at /api/payfast/notify. Vercel sends CRON_SECRET as a bearer token.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorised", { status: 401 });
  }
  const service = createServiceClient();

  // Trial emails: the day before the trial ends, and once it has ended
  const trial: { business_id: string; kind: string; sent: boolean }[] = [];
  const { data: trialDue } = await service.rpc("billing_trial_emails_due");
  for (const t of (trialDue ?? []) as {
    business_id: string; kind: "ending" | "ended"; business_name: string; reference: string; email: string;
    discount_until: string; shifts_closed: number; alerts: number; missing_value: number; cash_short: number;
  }[]) {
    const sent = await sendTrialEmail({
      kind: t.kind, businessName: t.business_name, reference: t.reference, email: t.email,
      discountUntil: t.discount_until, shiftsClosed: t.shifts_closed, alerts: t.alerts,
      missingValue: Number(t.missing_value), cashShort: Number(t.cash_short),
    });
    if (sent) await service.rpc("billing_mark_trial_email", { p_business: t.business_id, p_kind: t.kind });
    trial.push({ business_id: t.business_id, kind: t.kind, sent });
  }

  if (!payfastConfigured()) return NextResponse.json({ trial, skipped: "card payments not set up" });

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
  return NextResponse.json({ trial, charged: results.length, results });
}
