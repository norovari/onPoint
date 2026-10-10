import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireSession } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { checkoutForm, payfastConfigured } from "@/lib/payfast";
import { planName } from "@/lib/plans";
import { formatZar } from "@/lib/calculations";
import { AutoSubmit } from "./AutoSubmit";

export const metadata = { title: "Pay" };

async function siteUrl() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
}

// Hands the owner over to PayFast's secure card page with a signed form.
export default async function Pay({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await requireSession();
  if (s.role !== "owner") redirect("/billing");
  if (!payfastConfigured()) redirect("/billing");
  const { data: pay } = await s.supabase.from("invoices")
    .select("id, reference, subscription_ref, plan, amount, status").eq("id", id).maybeSingle();
  if (!pay) notFound();
  if (pay.status !== "pending") redirect("/billing");
  const { data: user } = await s.supabase.auth.getUser();

  const form = checkoutForm({
    siteUrl: await siteUrl(),
    email: user.user?.email ?? "",
    paymentReference: pay.reference,
    customerReference: pay.subscription_ref,
    amount: Number(pay.amount),
    itemName: `OnPoint ${planName(pay.plan)} (monthly)`,
    businessName: s.businessName,
  });

  return (
    <Shell businessName={s.businessName}>
      <h1>Taking you to PayFast</h1>
      <p className="lede">{planName(pay.plan)} plan, {formatZar(pay.amount)}. Reference <strong className="mono">{pay.reference}</strong>.</p>
      <p className="muted">You’ll pay on PayFast’s secure page. Your card is saved there for the monthly payment; OnPoint never sees your card number.</p>
      <form id="payfast" action={form.action} method="post">
        {form.fields.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <button type="submit">Continue to PayFast</button>
      </form>
      <AutoSubmit formId="payfast" />
    </Shell>
  );
}
