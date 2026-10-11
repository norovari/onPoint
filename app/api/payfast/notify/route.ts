import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyItn } from "@/lib/payfast";
import { notifyAdmin } from "@/lib/notify";

// PayFast posts every payment result here (first checkout and monthly charges).
// Nothing is trusted until the signature checks out and PayFast confirms it.
export async function POST(request: NextRequest) {
  const raw = await request.text();
  let v: Awaited<ReturnType<typeof verifyItn>>;
  try {
    v = await verifyItn(raw);
  } catch (e) {
    console.error("PayFast notify", (e as Error).message);
    return new NextResponse("Error", { status: 500 }); // PayFast retries
  }
  if (!v.ok) {
    console.error("PayFast notify rejected:", v.reason);
    return new NextResponse("Rejected", { status: 400 });
  }
  const d = v.data;
  const reference = d.m_payment_id;
  if (!reference) return new NextResponse("OK");
  const service = createServiceClient();
  try {
    if (d.payment_status === "COMPLETE") {
      const { error } = await service.rpc("billing_record_card_payment", {
        p_reference: reference,
        p_amount_cents: Math.round(Number(d.amount_gross) * 100),
        p_currency: "ZAR",
        p_authorization: d.token || null,
        p_reusable: Boolean(d.token),
        p_customer: d.pf_payment_id || null,
        p_email: d.email_address || null,
      });
      if (error) throw new Error(error.message);
      await notifyAdmin(`Payment received: R${d.amount_gross} (${reference})`, [
        `A card payment went through.`,
        "",
        `Amount: R${d.amount_gross}`,
        `Payment reference: ${reference}`,
        `For: ${d.item_name ?? ""}`,
        `Paid by: ${d.email_address ?? ""}`,
        `Card saved for monthly charges: ${d.token ? "yes" : "no"}`,
      ]);
    } else if (d.payment_status === "FAILED") {
      const { data: pay } = await service.from("invoices").select("seq").eq("reference", reference).maybeSingle();
      if (pay && (pay.seq ?? 1) > 1) {
        await service.rpc("billing_renewal_failed", { p_reference: reference });
        await notifyAdmin(`Monthly payment failed (${reference})`, [
          `A monthly card charge was declined. The shop keeps its plan for 7 days while it's retried.`,
          "",
          `Payment reference: ${reference}`,
          `Email: ${d.email_address ?? ""}`,
        ]);
      } else {
        await service.from("invoices").update({ status: "failed" }).eq("reference", reference).eq("status", "pending");
      }
    }
  } catch (e) {
    // References that aren't OnPoint payments are ignored
    console.error("PayFast notify", reference, (e as Error).message);
  }
  return new NextResponse("OK");
}
