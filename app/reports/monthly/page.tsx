import Link from "next/link";
import Decimal from "decimal.js";
import { requireSession } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { formatQty, formatZar } from "@/lib/calculations";
import { SampleReport } from "@/components/SampleReport";

export const metadata = { title: "Monthly report" };

// Business and Multi-site plans: what went missing most over the last 30 days, and on whose shifts.
export default async function Monthly() {
  const s = await requireSession();
  const { supabase, businessId } = s;
  const { data: plan } = await supabase.rpc("business_plan", { p_business: businessId });
  const allowed = ["business", "multi_site"].includes((plan as { plan: string }).plan);

  if (!allowed) {
    return (
      <Shell businessName={s.businessName}>
        <h1>Monthly report</h1>
        <div className="sheet" style={{ borderStyle: "dashed", borderWidth: 2 }}>
          <h2 style={{ marginTop: 0 }}>Part of the Business plan</h2>
          <p>See which products go missing most over the month, what it’s worth, which shifts the differences happen on, and how much cash came up short.</p>
          <Link href="/billing" className="button">See plans</Link>
        </div>
        <h2>What it looks like</h2>
        <SampleReport businessName={s.businessName} note="This is what your report would look like on the Business plan. The numbers are made up." />
      </Shell>
    );
  }

  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [{ data: ex }, { data: shifts }, { data: prices }] = await Promise.all([
    supabase
      .from("exceptions")
      .select("exception_type, difference, product_id, shift_id, status, products(name, base_unit)")
      .gte("created_at", since)
      .eq("stage", "closing")
      .neq("status", "superseded"),
    supabase
      .from("shifts")
      .select("id, opened_at, status, opener:profiles!shifts_opened_by_fkey(full_name), closer:profiles!shifts_closed_by_fkey(full_name)")
      .gte("opened_at", since),
    supabase.from("product_prices").select("product_id, unit_price").is("valid_to", null),
  ]);
  const price = new Map((prices ?? []).map((p) => [p.product_id, p.unit_price as string]));

  const byProduct = new Map<string, { name: string; unit: string; qty: Decimal; value: Decimal; times: number }>();
  let cashShort = new Decimal(0);
  let specialsExtra = 0;
  const perPerson = new Map<string, { shifts: number; alerts: number; missing: Decimal }>();
  const shiftPerson = new Map((shifts ?? []).map((sh) => [sh.id, (sh.closer as unknown as { full_name: string } | null)?.full_name || (sh.opener as unknown as { full_name: string } | null)?.full_name || "Unknown"]));
  for (const sh of shifts ?? []) {
    if (sh.status === "opening" || sh.status === "active") continue;
    const who = shiftPerson.get(sh.id)!;
    const cur = perPerson.get(who) ?? { shifts: 0, alerts: 0, missing: new Decimal(0) };
    cur.shifts++;
    perPerson.set(who, cur);
  }
  for (const e of ex ?? []) {
    const who = shiftPerson.get(e.shift_id);
    if (who && e.exception_type !== "low_stock") {
      const cur = perPerson.get(who) ?? { shifts: 0, alerts: 0, missing: new Decimal(0) };
      cur.alerts++;
      perPerson.set(who, cur);
    }
    if (e.exception_type === "stock_variance" && e.difference !== null && Number(e.difference) < 0 && e.product_id) {
      const p = e.products as unknown as { name: string; base_unit: string };
      const qty = new Decimal(e.difference).negated();
      const value = qty.times(price.get(e.product_id) ?? 0);
      const cur = byProduct.get(e.product_id) ?? { name: p.name, unit: p.base_unit, qty: new Decimal(0), value: new Decimal(0), times: 0 };
      cur.qty = cur.qty.plus(qty); cur.value = cur.value.plus(value); cur.times++;
      byProduct.set(e.product_id, cur);
      if (who) perPerson.get(who)!.missing = perPerson.get(who)!.missing.plus(value);
    }
    if (e.exception_type === "cash_variance" && e.difference !== null && Number(e.difference) < 0) cashShort = cashShort.plus(new Decimal(e.difference).negated());
    if (e.exception_type === "special_mismatch" && Number(e.difference) > 0) specialsExtra += Number(e.difference);
  }
  const products = [...byProduct.values()].sort((a, b) => b.value.comparedTo(a.value));
  const missingTotal = products.reduce((a, p) => a.plus(p.value), new Decimal(0));
  const closed = (shifts ?? []).filter((sh) => sh.status !== "opening" && sh.status !== "active").length;

  if (closed === 0) {
    return (
      <Shell businessName={s.businessName}>
        <h1>Monthly report</h1>
        <SampleReport businessName={s.businessName} note="Your own report fills in as you close shifts. Until then, here's a sample with made-up numbers." />
      </Shell>
    );
  }

  return (
    <Shell businessName={s.businessName}>
      <h1>Monthly report</h1>
      <p className="lede">The last 30 days. Differences are things to look into, not proof of wrongdoing.</p>
      <div className="figures">
        <div className="figure"><div className="value">{closed}</div><div className="label">Shifts closed</div></div>
        <div className="figure"><div className="value" style={{ color: `var(--${missingTotal.isZero() ? "matched" : "variance"})` }}>{formatZar(missingTotal.toNumber())}</div><div className="label">Missing stock value</div></div>
        <div className="figure"><div className="value" style={{ color: `var(--${cashShort.isZero() ? "matched" : "variance"})` }}>{formatZar(cashShort.toNumber())}</div><div className="label">Cash short</div></div>
        <div className="figure"><div className="value">{specialsExtra}</div><div className="label">Extra items out on specials</div></div>
      </div>

      <h2>What goes missing most</h2>
      {products.length === 0 ? <p className="notice ok">Nothing went missing in the last 30 days.</p> : (
        <ul className="lines">
          {products.map((p) => (
            <li key={p.name} className="line" data-status="variance">
              <span className="name">{p.name}</span>
              <span className="diff" data-status="variance" style={{ fontSize: 20 }}>{formatZar(p.value.toNumber())}</span>
              <span className="meta">{formatQty(p.qty.toString(), p.unit)} missing over {p.times} shift{p.times === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ul>
      )}

      <h2>By person closing the shift</h2>
      <div className="scroll">
        <table className="data">
          <thead><tr><th>Person</th><th className="num">Shifts</th><th className="num">Alerts</th><th className="num">Missing stock</th></tr></thead>
          <tbody>
            {[...perPerson.entries()].sort((a, b) => b[1].missing.comparedTo(a[1].missing)).map(([who, v]) => (
              <tr key={who}><td>{who}</td><td className="num">{v.shifts}</td><td className="num">{v.alerts}</td><td className="num">{formatZar(v.missing.toNumber())}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Missing stock is valued at today’s selling prices.</p>
    </Shell>
  );
}
