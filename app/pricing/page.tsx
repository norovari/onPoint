import Link from "next/link";
import { CONTACT_EMAIL, LAUNCH_DISCOUNT, LEGAL_NAME, PLANS, TRIAL_DAYS } from "@/lib/plans";

export const metadata = { title: "Pricing" };

export default function Pricing() {
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" style={{ textDecoration: "none" }}>On<b>Point</b></Link>
        <nav className="nav"><Link href="/login">Sign in</Link></nav>
      </header>
      <main className="wrap">
        <h1>Pricing</h1>
        <p className="lede">
          Every new shop gets {TRIAL_DAYS} days of the Business plan free, no card needed. After that, stay on Free or choose a plan. Subscribe within {LAUNCH_DISCOUNT.hours} hours of signing up and your first {LAUNCH_DISCOUNT.months} monthly payments are {LAUNCH_DISCOUNT.pct}% off.
        </p>
        {PLANS.map((p) => (
          <div key={p.id} className="sheet">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              <span style={{ fontSize: 26, fontWeight: 800 }}>{p.price ? `R${p.price.toLocaleString("en-ZA")}` : "R0"}<span className="small muted"> a month</span></span>
            </div>
            <p className="muted" style={{ margin: "4px 0 6px" }}>{p.blurb}</p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
            {p.price > 0 && (
              <p className="small muted" style={{ margin: "8px 0 0" }}>
                Launch price for the first {LAUNCH_DISCOUNT.months} months: R{(Math.round(p.price * (100 - LAUNCH_DISCOUNT.pct)) / 100).toFixed(2)} a month
              </p>
            )}
          </div>
        ))}
        <p className="muted small">Prices are in rand and include everything shown. Pay by card (billed monthly) or EFT. Cancel any time. Your plan runs to the end of the month you paid for.</p>
        <Link href="/signup" className="button" style={{ width: "100%" }}>Start free</Link>
        <footer className="muted small" style={{ marginTop: 40, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
          {LEGAL_NAME}{CONTACT_EMAIL ? `. Questions: ${CONTACT_EMAIL}` : ""}. <Link href="/terms">Terms, privacy and refunds</Link>
        </footer>
      </main>
    </>
  );
}
