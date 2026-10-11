import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LAUNCH_DISCOUNT, LEGAL_NAME, PLANS, TRIAL_DAYS } from "@/lib/plans";

export const metadata = {
  title: "OnPoint – Dispensary Tracker",
  description: "Every shift accounted for. Without counting everything, every night.",
};

// Every feature here must be live in the app. Keep it short: one line each.
const FEATURES: { group: string; items: { t: string; d: string; isNew?: boolean }[] }[] = [
  {
    group: "Counting that staff can keep up",
    items: [
      { t: "Spot-checks, not full counts", d: "OnPoint picks about 12 products per close: a few at random, ones that didn’t tally lately, and ones due a check. Every product is still covered within the days you set.", isNew: true },
      { t: "Count split between staff", d: "The list is shared out at random between whoever is on shift. Everyone counts different products every time, and nobody can count someone else’s.", isNew: true },
      { t: "Weigh the whole jar", d: "Enter each empty jar’s weight once. Staff put the jar on the scale and type the reading; OnPoint takes off the jar.", isNew: true },
      { t: "Blind counts", d: "Staff count without seeing what the system expects. A recount adds a new version with a reason; the first count is never overwritten." },
    ],
  },
  {
    group: "Accountability at every close",
    items: [
      { t: "End-of-shift statements", d: "Each person answers three quick questions on their phone, takes photos of the jars on the scale and the cash drawer, and confirms with their own password.", isNew: true },
      { t: "Cash and card, every shift", d: "The cash counted and the card machine total are checked against the till, even on nights you only spot-check stock." },
      { t: "Alerts you have to clear", d: "When something doesn’t tally, it stays open until someone picks a reason or writes what happened. A manager signs off each shift." },
      { t: "Fair to your team", d: "OnPoint shows differences, not blame. Staff see their own figures; managers and the owner see everything." },
    ],
  },
  {
    group: "Fits how you already sell",
    items: [
      { t: "Works with your till", d: "Upload the till’s sales export, CSV or Excel, any layout. OnPoint asks once which column is which, then remembers. No till? It works out sales from the counts." },
      { t: "Fixed-price bags", d: "Sell 2g for R50 but bag 2.2g? Set the bag size and an allowance, and a little extra won’t raise an alert. Too much extra will.", isNew: true },
      { t: "Specials tallied on their own", d: "Deals like “any 2 pre-rolls for R200” are counted separately: what sold, the mix people chose, and what it cost you." },
      { t: "No app to install", d: "Runs in the browser on any phone, tablet or computer. Each person signs in with their own login." },
    ],
  },
  {
    group: "What the owner gets",
    items: [
      { t: "An email every night", d: "When a shift closes: whether it tallied, what to look at, and everyone’s statements with a link to the photos." },
      { t: "One clear page per shift", d: "Stock, cash and card side by side, with plain-words explanations of any difference." },
      { t: "Monthly report", d: "What sells and when, which days and products keep coming up short, and what to do next. Business plan." },
      { t: "Your numbers stay yours", d: "Only people you add see your shop. Ask any time and we’ll export or delete your data." },
    ],
  },
];

export default async function Home() {
  // Signed-in users go straight to their shop
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) redirect("/today");
  } catch (e) {
    if ((e as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw e;
  }
  const from = PLANS.find((p) => p.price > 0)!.price;

  return (
    <>
      <header className="topbar">
        <span className="brand">On<b>Point</b></span>
        <nav className="nav" aria-label="Main">
          <Link href="/pricing">Pricing</Link>
          <Link href="/faq">Questions</Link>
          <Link href="/login">Sign in</Link>
        </nav>
      </header>
      <main className="wrap">
        <p className="small" style={{ margin: "24px 0 0", fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--ink-soft)" }}>Stock and cash control for dispensaries</p>
        <h1 style={{ fontSize: 36, margin: "6px 0 10px", lineHeight: 1.15 }}>Every shift accounted for. Without counting everything, every night.</h1>
        <p className="lede" style={{ fontSize: 18 }}>
          Your till knows what was sold. OnPoint checks it against what’s left on the shelf and in the till at every handover, and tells you in plain words if something doesn’t tally.
        </p>

        <form action="/demo" method="get" className="sheet" style={{ borderWidth: 2 }}>
          <label htmlFor="b" style={{ marginTop: 0, fontSize: 17 }}>Your dispensary’s name</label>
          <input id="b" name="b" required maxLength={80} placeholder="e.g. Green Leaf Club" autoComplete="organization" />
          <div style={{ marginTop: 12 }}>
            <button type="submit" style={{ width: "100%" }}>See it for my shop</button>
          </div>
          <p className="muted small" style={{ margin: "10px 0 0" }}>Opens a sample shift with your name on it. No sign-up needed.</p>
        </form>

        <h2>How a shift works</h2>
        <ol className="howto">
          <li><strong>Open.</strong> Count the float. Stock starts from the last close, so there’s no full count to begin.</li>
          <li><strong>Close.</strong> Upload the till file. Each person counts their share of a short list, answers three questions, adds photos and confirms.</li>
          <li><strong>Know.</strong> The owner gets one clear answer that night: everything tallied, or exactly what to look at.</li>
        </ol>

        <div id="features">
          {FEATURES.map((g, i) => (
            <section key={g.group} aria-labelledby={`f${i}`}>
              <h2 id={`f${i}`}>{g.group}</h2>
              <div className="features">
                {g.items.map((f) => (
                  <div key={f.t} className="feature">
                    <h3>{f.t}{f.isNew && <span className="badge">New</span>}</h3>
                    <p>{f.d}</p>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="sheet" style={{ marginTop: 28, borderWidth: 2 }}>
          <h2 style={{ marginTop: 0 }}>Try it free</h2>
          <p style={{ marginTop: 0 }}>
            {TRIAL_DAYS} days with everything switched on, no card needed. Then from R{from} a month, month to month.
            Subscribe before your trial ends and your first {LAUNCH_DISCOUNT.months} months are {LAUNCH_DISCOUNT.pct}% off.
          </p>
          <Link href="/signup" className="button" style={{ width: "100%" }}>Start {TRIAL_DAYS} days free</Link>
          <p className="small" style={{ margin: "10px 0 0" }}>
            <Link href="/pricing">Compare plans</Link> · <Link href="/faq">Questions</Link> · <a href="https://wa.me/27696425639">WhatsApp us</a>
          </p>
        </div>

        <footer className="muted small" style={{ marginTop: 40, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
          OnPoint is a service of {LEGAL_NAME}. <Link href="/terms">Terms, privacy and refunds</Link>
        </footer>
      </main>
    </>
  );
}
