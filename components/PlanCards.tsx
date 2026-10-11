import Link from "next/link";
import { LAUNCH_DISCOUNT, PLANS, TRIAL_DAYS } from "@/lib/plans";

// The paid plans at a glance, for the demo and sample report pages.
const launch = (p: number) => Math.round(p * (100 - LAUNCH_DISCOUNT.pct)) / 100;

export function PlanCards({ signup, name }: { signup: string; name: string }) {
  const paid = PLANS.filter((p) => p.price > 0);
  return (
    <section id="prices" aria-labelledby="prices-h" style={{ marginTop: 28 }}>
      <h2 id="prices-h">Prices</h2>
      <p className="small" style={{ marginTop: -4 }}>
        {TRIAL_DAYS} days free with everything on, no card needed. Then month to month, cancel any time.
        Subscribe before your trial ends and your first {LAUNCH_DISCOUNT.months} months are <strong>{LAUNCH_DISCOUNT.pct}% off</strong>.
      </p>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
        {paid.map((p) => (
          <div key={p.id} className="sheet" style={{ margin: 0, borderWidth: p.id === "business" ? 2 : undefined, borderColor: p.id === "business" ? "var(--ink)" : undefined }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <h3 style={{ margin: 0 }}>{p.name}</h3>
              {p.id === "business" && <span className="small" style={{ fontWeight: 700 }}>Includes the monthly report</span>}
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>
              R{launch(p.price).toFixed(2).replace(/\.00$/, "").replace(/\B(?=(\d{3})+(?!\d))/, " ")}<span className="small muted" style={{ fontWeight: 400 }}> a month</span>
            </p>
            <p className="small muted" style={{ margin: "2px 0 8px" }}>for {LAUNCH_DISCOUNT.months} months, then R{String(p.price).replace(/\B(?=(\d{3})+(?!\d))/g, " ")}</p>
            <p className="small" style={{ margin: "0 0 6px" }}>{p.blurb}</p>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{p.features.slice(0, 4).map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
        ))}
      </div>
      <p className="small" style={{ marginTop: 10 }}>
        <Link href={signup}>Start {name ? `${name}’s` : "your"} free trial</Link> · <Link href="/pricing">Compare all plans</Link> · <Link href="/faq">Questions</Link>
      </p>
    </section>
  );
}
