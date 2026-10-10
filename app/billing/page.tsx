import { requireSession } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { startCheckout } from "@/app/actions";
import { cardConfigured, eftConfigured, LAUNCH_DISCOUNT, PLANS, planName } from "@/lib/plans";
import { formatZar } from "@/lib/calculations";
import { when } from "@/lib/labels";

export const metadata = { title: "Plan" };

export default async function Billing({ searchParams }: { searchParams: Promise<{ paid?: string; failed?: string; check?: string }> }) {
  const q = await searchParams;
  const s = await requireSession();
  const { supabase, businessId, role } = s;
  const [{ data: plan }, { data: invoices }] = await Promise.all([
    supabase.rpc("business_plan", { p_business: businessId }),
    role === "owner"
      ? supabase.from("invoices").select("id, number, plan, method, amount, discount_pct, status, created_at, paid_at").order("created_at", { ascending: false }).limit(12)
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const p = plan as {
    plan: string; subscribed_plan: string; status: string; current_period_end: string | null; payment_method: string | null;
    discount_cycles_remaining: number; launch_discount_open: boolean; launch_discount_until: string | null; history_days: number | null;
  };
  const owner = role === "owner";
  const card = cardConfigured();
  const eft = eftConfigured();
  const hoursLeft = p.launch_discount_until ? Math.max(0, Math.floor((new Date(p.launch_discount_until).getTime() - Date.now()) / 3600_000)) : 0;

  return (
    <Shell businessName={s.businessName}>
      <h1>Your plan</h1>
      {q.paid && <p className="notice ok">Payment received. Thank you.</p>}
      {q.failed && <p className="notice error">The card payment didn’t go through. Try again or choose EFT.</p>}
      {q.check && <p className="notice">We couldn’t confirm the payment yet. If money left your account, it will show here within a few minutes.</p>}

      <div className="sheet">
        <p style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{planName(p.plan)}</p>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {p.status === "trialing" && `Free trial of ${planName(p.subscribed_plan)} until ${when(p.current_period_end)}. After that you move to Free unless you choose a plan.`}
          {p.status === "active" && `Paid until ${when(p.current_period_end)}${p.payment_method === "card" ? ", renews automatically by card" : ", by EFT"}.`}
          {p.status === "past_due" && "Your last card payment failed. Update it within 7 days to keep your plan."}
          {p.status === "cancelled" && "Your plan has ended. You’re on Free."}
          {p.discount_cycles_remaining > 0 && ` Launch discount on your next ${p.discount_cycles_remaining} payment${p.discount_cycles_remaining === 1 ? "" : "s"}.`}
        </p>
        <p className="muted small" style={{ margin: "6px 0 0" }}>History kept: {p.history_days ? `last ${p.history_days} days` : "everything"}.</p>
      </div>

      {p.launch_discount_open && owner && (
        <p className="notice ok"><strong>Launch offer:</strong> subscribe in the next {hoursLeft} hour{hoursLeft === 1 ? "" : "s"} and your first {LAUNCH_DISCOUNT.months} months are {LAUNCH_DISCOUNT.pct}% off.</p>
      )}

      {!owner && <p className="muted">Only the owner can change the plan.</p>}

      {owner && (
        <>
          <h2>Choose a plan</h2>
          {!card && !eft && <p className="notice">Payments aren’t set up yet. Contact OnPoint to subscribe.</p>}
          {PLANS.filter((x) => x.price > 0).map((x) => {
            const price = p.launch_discount_open ? Math.round(x.price * (100 - LAUNCH_DISCOUNT.pct)) / 100 : x.price;
            const current = p.status === "active" && p.subscribed_plan === x.id;
            return (
              <ActionForm key={x.id} action={startCheckout} hidden={{ plan: x.id }} className="sheet">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <h3 style={{ fontSize: 20 }}>{x.name}{current ? " (your plan)" : ""}</h3>
                  <span style={{ fontSize: 24, fontWeight: 800 }}>
                    {formatZar(price)}<span className="small muted"> a month</span>
                  </span>
                </div>
                {p.launch_discount_open && <p className="small muted" style={{ margin: "2px 0 0" }}>Normally {formatZar(x.price)}. {LAUNCH_DISCOUNT.pct}% off for {LAUNCH_DISCOUNT.months} months.</p>}
                <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>{x.features.map((f) => <li key={f}>{f}</li>)}</ul>
                <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                  {card && <Submit name="method" value="card">Pay by card</Submit>}
                  {eft && <Submit className={card ? "quiet" : ""} name="method" value="eft">Pay by EFT</Submit>}
                </div>
              </ActionForm>
            );
          })}

          {(invoices ?? []).length > 0 && (
            <>
              <h2>Invoices</h2>
              <div className="scroll">
                <table className="data">
                  <thead><tr><th>No.</th><th>Plan</th><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {(invoices ?? []).map((i) => (
                      <tr key={i.id}>
                        <td><a href={`/billing/invoice/${i.id}`}>{i.number}</a></td>
                        <td>{planName(i.plan)}</td>
                        <td>{when(i.created_at)}</td>
                        <td className="num">{formatZar(i.amount)}</td>
                        <td>{i.status === "pending" ? (i.method === "eft" ? "Waiting for EFT" : "Not paid") : i.status === "paid" ? "Paid" : i.status === "void" ? "Cancelled" : "Failed"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="muted small">To cancel, contact OnPoint. Your plan runs to the end of the month you paid for.</p>
        </>
      )}
    </Shell>
  );
}
