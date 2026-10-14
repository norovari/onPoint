import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { adminSetPlan } from "@/app/actions";
import { planName } from "@/lib/plans";
import { formatZar } from "@/lib/calculations";
import { when } from "@/lib/labels";
import { createServiceClient } from "@/lib/supabase/service";

export const metadata = { title: "Admin" };

interface Account {
  id: string; name: string; created_at: string; owner_email: string | null; plan: string; status: string;
  current_period_end: string | null; payment_method: string | null; discount_cycles_remaining: number; effective_plan: string;
  list_price: number; team: number; locations: number; products: number; shifts_30d: number; last_shift_at: string | null;
  open_alerts: number; total_paid: number; reference: string; last_paid_at: string | null;
}
interface Pay { id: string; subscription_ref: string; business: string; plan: string; reference: string; amount: number; discount_pct: number; status: string; created_at: string; paid_at: string | null }

type Agri = { id: string; created_at: string; farmer: string; farm: string | null; phone: string; province: string; town: string | null; crop: string; qty: string; unit: string; price: string | null; available_from: string | null; delivery: string; notes: string | null; plan: string | null };

// Only the confirmed nyorovai@gmail.com sign-in passes this check (enforced in the database too).
export default async function Admin({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const search = ((await searchParams).q ?? "").trim().toLowerCase();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: isAdmin } = await supabase.rpc("am_platform_admin");
  if (isAdmin !== true) notFound();

  const [{ data: overview }, { data: pending }] = await Promise.all([
    supabase.rpc("admin_overview"),
    supabase.rpc("admin_invoices", { p_status: "all" }),
  ]);
  const { data: agri } = await supabase.rpc("admin_agri_listings");
  const listings = (agri ?? []) as Agri[];
  const allAccounts = (overview ?? []) as Account[];
  const allPayments = (pending ?? []) as Pay[];
  const match = (...v: (string | null)[]) => !search || v.some((x) => (x ?? "").toLowerCase().includes(search));
  const accounts = allAccounts.filter((a) => match(a.reference, a.name, a.owner_email));
  const payments = allPayments.filter((p) => match(p.subscription_ref, p.reference, p.business)).slice(0, 50);
  const paying = allAccounts.filter((a) => a.status === "active" && a.effective_plan !== "free");
  const monthly = paying.reduce((sum, a) => sum + Number(a.list_price) * (a.discount_cycles_remaining > 0 ? 0.8 : 1), 0);
  const trials = allAccounts.filter((a) => a.status === "trialing" && a.effective_plan !== "free");
  const totalPaid = allAccounts.reduce((s, a) => s + Number(a.total_paid), 0);

  // Demo engagement over the last 7 days, one row per shop (newest first)
  type Ev = { shop: string; kind: string; event: string; visitor: string | null; created_at: string };
  let events: Ev[] = [];
  try {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data } = await createServiceClient().from("demo_events").select("shop, kind, event, visitor, created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(2000);
    events = (data ?? []) as Ev[];
  } catch { /* service key missing locally */ }
  const demos = new Map<string, { shop: string; kind: string; last: string; visitors: Set<string>; opens: number; did: Set<string> }>();
  for (const e of events) {
    const k = `${e.kind}|${e.shop.toLowerCase()}`;
    const d = demos.get(k) ?? { shop: e.shop, kind: e.kind, last: e.created_at, visitors: new Set(), opens: 0, did: new Set() };
    if (e.visitor) d.visitors.add(e.visitor);
    if (e.event === "open") d.opens++; else d.did.add(e.event);
    demos.set(k, d);
  }
  const todayStart = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }) + "T00:00:00+02:00").getTime();
  const openedToday = new Set(events.filter((e) => e.event === "open" && new Date(e.created_at).getTime() >= todayStart).map((e) => `${e.kind}|${e.shop.toLowerCase()}`)).size;
  const DID: Record<string, string> = { staff: "tried staff view", submit: "submitted a close", report: "opened the report", signup: "tapped Start free" };

  return (
    <Shell>
      <h1>OnPoint admin</h1>
      <p className="lede">Your dispensaries, their plans and how actively they use OnPoint. Their stock, sales and cash are never shown here.</p>

      <div className="figures">
        <div className="figure"><div className="value">{allAccounts.length}</div><div className="label">Signed up</div></div>
        <div className="figure"><div className="value">{paying.length}</div><div className="label">Paying</div></div>
        <div className="figure"><div className="value">{trials.length}</div><div className="label">On free trial</div></div>
        <div className="figure"><div className="value">{formatZar(monthly)}</div><div className="label">Monthly income now</div></div>
      </div>
      <p className="muted small">Collected so far: {formatZar(totalPaid)}.</p>

      <form method="get" className="row" style={{ margin: "16px 0", flexWrap: "wrap" }}>
        <label htmlFor="q" className="sr-only">Search</label>
        <input id="q" name="q" defaultValue={search} placeholder="Search by reference (NY0R0…), business or email" style={{ flex: "1 1 260px" }} />
        <button type="submit" className="quiet">Search</button>
        {search && <a href="/admin" className="small">Clear</a>}
      </form>

      <h2>Demo visits</h2>
      <p className="muted small">Personal demo links opened in the last 7 days ({openedToday} today). Link previews in WhatsApp aren’t counted. Open any demo once with <code>#me</code> on the end so your own visits aren’t counted.</p>
      {demos.size === 0 ? <p className="muted">No demo visits recorded yet.</p> : (
        <div className="scroll">
          <table className="data">
            <thead><tr><th>Shop</th><th>Last opened</th><th className="num">Visits</th><th>Went on to</th></tr></thead>
            <tbody>
              {[...demos.values()].map((d) => (
                <tr key={`${d.kind}|${d.shop}`}>
                  <td>{d.shop}{d.kind === "bar" ? <span className="muted small"> (bar)</span> : null}</td>
                  <td>{when(d.last)}</td>
                  <td className="num">{d.opens}{d.visitors.size > 1 ? ` (${d.visitors.size} people)` : ""}</td>
                  <td className="small">{[...d.did].map((x) => DID[x]).join(", ") || <span className="muted">just looked</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>AgriLink listings</h2>
      <p className="muted small">Produce farmers listed at <a href="/agrilink">/agrilink</a>. Newest first.</p>
      {listings.length === 0 ? <p className="muted">No listings yet.</p> : (
        <div className="scroll">
          <table className="data">
            <thead><tr><th>Listed</th><th>Farmer</th><th>WhatsApp</th><th>Where</th><th>Crop</th><th className="num">Amount</th><th className="num">Price</th><th>Ready</th><th>Delivery</th><th>Plan</th><th>Notes</th></tr></thead>
            <tbody>
              {listings.map((l) => (
                <tr key={l.id}>
                  <td>{when(l.created_at)}</td>
                  <td>{l.farmer}{l.farm ? <span className="muted small"> ({l.farm})</span> : null}</td>
                  <td className="mono"><a href={`https://wa.me/${l.phone.replace(/\D/g, "").replace(/^0/, "27")}`} target="_blank" rel="noopener">{l.phone}</a></td>
                  <td>{[l.town, l.province].filter(Boolean).join(", ")}</td>
                  <td>{l.crop}</td>
                  <td className="num">{Number(l.qty)} {l.unit}</td>
                  <td className="num">{l.price !== null ? `R${Number(l.price)}` : "–"}</td>
                  <td>{l.available_from ?? "now"}</td>
                  <td>{l.delivery === "deliver" ? "delivers" : "collect"}</td>
                  <td>{l.plan && l.plan !== "unsure" ? l.plan : <span className="muted">–</span>}</td>
                  <td className="small">{l.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Payments</h2>
      {payments.length === 0 ? <p className="muted">{search ? "No payments match." : "No payments yet."}</p> : (
        <div className="scroll">
          <table className="data">
            <thead><tr><th>Customer ref</th><th>Payment ref</th><th>Business</th><th>Plan</th><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="mono"><a href={`/admin?q=${p.subscription_ref}`}>{p.subscription_ref}</a></td>
                  <td className="mono">{p.reference}</td>
                  <td>{p.business}</td>
                  <td>{planName(p.plan)}{p.discount_pct ? ` (${p.discount_pct}% off)` : ""}</td>
                  <td>{when(p.paid_at ?? p.created_at)}</td>
                  <td className="num">{formatZar(p.amount)}</td>
                  <td><span className="status" data-status={p.status === "paid" ? "matched" : p.status === "failed" ? "variance" : "pending"}>{p.status === "paid" ? "Paid" : p.status === "failed" ? "Failed" : "Not completed"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Accounts</h2>
      {accounts.length === 0 && <p className="muted">No one has signed up yet. Share the front page with dispensaries.</p>}
      {accounts.map((a) => (
        <div key={a.id} className="sheet">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
            <h3 style={{ fontSize: 19 }}><span className="mono">{a.reference}</span> · {a.name}</h3>
            <span className="status" data-status={a.effective_plan === "free" ? "neutral" : a.status === "active" ? "matched" : a.status === "past_due" ? "variance" : "pending"}>
              {a.status === "trialing" && a.effective_plan !== "free" ? `Trial until ${when(a.current_period_end)}` : `${planName(a.effective_plan)}${a.status === "past_due" ? ", payment failed" : ""}`}
            </span>
          </div>
          <p className="muted small" style={{ margin: "4px 0 8px" }}>
            {a.owner_email ?? "No owner email"}. Joined {when(a.created_at)}.
            {a.status === "active" && a.current_period_end ? ` Paid until ${when(a.current_period_end)}.` : ""}
            {a.last_paid_at ? ` Last payment ${when(a.last_paid_at)}.` : " No payments yet."}
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
            <p className="muted small">For extending a trial or giving a free month.</p>
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
