import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { adminMarkPaid, adminSetPlan } from "@/app/actions";
import { planName } from "@/lib/plans";
import { formatZar } from "@/lib/calculations";
import { when } from "@/lib/labels";

export const metadata = { title: "Admin" };

interface Account {
  id: string; name: string; created_at: string; owner_email: string | null; plan: string; status: string;
  current_period_end: string | null; payment_method: string | null; discount_cycles_remaining: number; effective_plan: string;
  list_price: number; team: number; locations: number; products: number; shifts_30d: number; last_shift_at: string | null;
  open_alerts: number; pending_invoices: number; total_paid: number;
}
interface Inv { id: string; number: number; business: string; plan: string; method: string; reference: string; amount: number; discount_pct: number; status: string; created_at: string }

// Only the confirmed nyorovai@gmail.com sign-in passes this check (enforced in the database too).
export default async function Admin() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: isAdmin } = await supabase.rpc("am_platform_admin");
  if (isAdmin !== true) notFound();

  const [{ data: overview }, { data: pending }] = await Promise.all([
    supabase.rpc("admin_overview"),
    supabase.rpc("admin_invoices", { p_status: "pending" }),
  ]);
  const accounts = (overview ?? []) as Account[];
  const invoices = (pending ?? []) as Inv[];
  const paying = accounts.filter((a) => a.status === "active" && a.effective_plan !== "free");
  const monthly = paying.reduce((sum, a) => sum + Number(a.list_price) * (a.discount_cycles_remaining > 0 ? 0.8 : 1), 0);
  const trials = accounts.filter((a) => a.status === "trialing" && a.effective_plan !== "free");
  const totalPaid = accounts.reduce((s, a) => s + Number(a.total_paid), 0);

  return (
    <Shell>
      <h1>OnPoint admin</h1>
      <p className="lede">Your dispensaries, their plans and how actively they use OnPoint. Their stock, sales and cash are never shown here.</p>

      <div className="figures">
        <div className="figure"><div className="value">{accounts.length}</div><div className="label">Signed up</div></div>
        <div className="figure"><div className="value">{paying.length}</div><div className="label">Paying</div></div>
        <div className="figure"><div className="value">{trials.length}</div><div className="label">On free trial</div></div>
        <div className="figure"><div className="value">{formatZar(monthly)}</div><div className="label">Monthly income now</div></div>
      </div>
      <p className="muted small">Collected so far: {formatZar(totalPaid)}.</p>

      <h2>EFT payments to check</h2>
      {invoices.length === 0 ? <p className="muted">No invoices waiting.</p> : (
        <ul className="lines">
          {invoices.map((i) => (
            <li key={i.id} className="line" data-status="pending">
              <span className="name">{i.business}: {formatZar(i.amount)}</span>
              {i.method === "eft" ? (
                <ActionForm action={adminMarkPaid} hidden={{ invoice_id: i.id }}><Submit className="quiet">Mark paid</Submit></ActionForm>
              ) : <span className="small muted">Card, not completed</span>}
              <span className="meta">Invoice {i.number}, reference <strong>{i.reference}</strong>, {planName(i.plan)}{i.discount_pct ? `, ${i.discount_pct}% launch discount` : ""}, {when(i.created_at)}. Check your bank statement for this reference before marking it paid.</span>
            </li>
          ))}
        </ul>
      )}

      <h2>Accounts</h2>
      {accounts.length === 0 && <p className="muted">No one has signed up yet. Share the front page with dispensaries.</p>}
      {accounts.map((a) => (
        <div key={a.id} className="sheet">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
            <h3 style={{ fontSize: 19 }}>{a.name}</h3>
            <span className="status" data-status={a.effective_plan === "free" ? "neutral" : a.status === "active" ? "matched" : a.status === "past_due" ? "variance" : "pending"}>
              {a.status === "trialing" && a.effective_plan !== "free" ? `Trial until ${when(a.current_period_end)}` : `${planName(a.effective_plan)}${a.status === "past_due" ? ", payment failed" : ""}`}
            </span>
          </div>
          <p className="muted small" style={{ margin: "4px 0 8px" }}>
            {a.owner_email ?? "No owner email"}. Joined {when(a.created_at)}.
            {a.status === "active" && a.current_period_end ? ` Paid until ${when(a.current_period_end)} by ${a.payment_method === "card" ? "card" : "EFT"}.` : ""}
          </p>
          <table className="working"><tbody>
            <tr><td>Team members</td><td>{a.team}</td></tr>
            <tr><td>Shops and products</td><td>{a.locations} shop{a.locations === 1 ? "" : "s"}, {a.products} products</td></tr>
            <tr><td>Shifts closed in the last 30 days</td><td>{a.shifts_30d}</td></tr>
            <tr><td>Last shift closed</td><td>{when(a.last_shift_at)}</td></tr>
            <tr><td>Open alerts (count only)</td><td>{a.open_alerts}</td></tr>
            <tr><td>Paid to date</td><td>{formatZar(a.total_paid)}</td></tr>
          </tbody></table>
          <details style={{ marginTop: 8 }}>
            <summary>Change plan by hand</summary>
            <p className="muted small">For extending a trial, a free month, or fixing an EFT payment made without the reference.</p>
            <ActionForm action={adminSetPlan} hidden={{ business_id: a.id }}>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <div>
                  <label htmlFor={`plan-${a.id}`}>Plan</label>
                  <select id={`plan-${a.id}`} name="plan" defaultValue={a.plan}>
                    <option value="starter">Starter</option><option value="business">Business</option><option value="multi_site">Multi-site</option><option value="free">Free</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={`status-${a.id}`}>Status</label>
                  <select id={`status-${a.id}`} name="status" defaultValue={a.status}>
                    <option value="trialing">Trial</option><option value="active">Active (paid)</option><option value="cancelled">Cancelled</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={`days-${a.id}`}>For how many days</label>
                  <input id={`days-${a.id}`} name="days" type="number" min="0" max="400" defaultValue="30" />
                </div>
              </div>
              <div style={{ marginTop: 10 }}><Submit className="quiet">Save</Submit></div>
            </ActionForm>
          </details>
        </div>
      ))}
    </Shell>
  );
}
