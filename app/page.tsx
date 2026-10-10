import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LAUNCH_DISCOUNT, LEGAL_NAME, PLANS, TRIAL_DAYS } from "@/lib/plans";

export default async function Home() {
  // Signed-in users go straight to their shop
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) redirect("/today");
  } catch (e) {
    if ((e as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw e;
  }

  return (
    <>
      <header className="topbar">
        <span className="brand">On<b>Point</b></span>
        <nav className="nav" aria-label="Main">
          <Link href="/pricing">Pricing</Link>
          <Link href="/login">Sign in</Link>
        </nav>
      </header>
      <main className="wrap">
        <h1 style={{ fontSize: 38, marginTop: 28 }}>Does your stock and money tally after every shift?</h1>
        <p className="lede" style={{ fontSize: 19 }}>
          OnPoint is stock and cash control for dispensaries. Staff count at close. OnPoint works out what should be there, and you get an alert the moment stock or money goes missing.
        </p>

        <form action="/demo" method="get" className="sheet" style={{ borderWidth: 2 }}>
          <label htmlFor="b" style={{ marginTop: 0, fontSize: 17 }}>Your dispensary’s name</label>
          <input id="b" name="b" required maxLength={80} placeholder="e.g. Green Leaf Club" autoComplete="organization" />
          <div style={{ marginTop: 12 }}>
            <button type="submit" style={{ width: "100%" }}>See it for my shop</button>
          </div>
          <p className="muted small" style={{ margin: "10px 0 0" }}>Opens a sample shift with your name on it. No sign-up needed.</p>
        </form>

        <h2>What you see after every shift</h2>
        <ul className="lines">
          {[
            ["Last shift stock", "What was on the shelf when the shift started."],
            ["In stock now", "What staff counted at close, next to what should be there."],
            ["What each product made", "Money per product, and whether the cash and card machine tally."],
            ["Stock for next shift", "What the next shift starts with, and what’s running low."],
            ["Today’s specials", "Each deal tallied on its own: what sold, the mix people chose, what it cost you."],
          ].map(([t, d]) => (
            <li key={t} className="line" data-status="matched">
              <span className="name">{t}</span>
              <span className="meta">{d}</span>
            </li>
          ))}
        </ul>

        <h2>Alerts you have to clear</h2>
        <p>When stock and money don’t tally, a product goes into minus, or a special gives away more than it should, the owner gets an alert. It stays open until someone fixes it or writes what happened.</p>

        <h2>Pricing</h2>
        <p className="muted">
          {TRIAL_DAYS} days of everything free, then from R{PLANS[1].price} a month. Subscribe within {LAUNCH_DISCOUNT.hours} hours of signing up and your first {LAUNCH_DISCOUNT.months} months are {LAUNCH_DISCOUNT.pct}% off.
        </p>
        <div className="figures">
          {PLANS.map((p) => (
            <div key={p.id} className="figure">
              <div className="value">{p.price ? `R${p.price.toLocaleString("en-ZA")}` : "R0"}</div>
              <div className="label">{p.name}, {p.blurb.toLowerCase()}</div>
            </div>
          ))}
        </div>
        <p><Link href="/pricing">Compare plans</Link></p>

        <h2>Your numbers stay yours</h2>
        <p>Only your team sees your stock, sales and cash. OnPoint’s own admin view shows your plan and how often shifts are closed, never your figures.</p>

        <footer className="muted small" style={{ marginTop: 40, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
          OnPoint is a service of {LEGAL_NAME}. <Link href="/terms">Terms, privacy and refunds</Link>
        </footer>
      </main>
    </>
  );
}
