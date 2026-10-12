import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Compare } from "@/components/Compare";
import { LAUNCH_DISCOUNT, LEGAL_NAME, PLANS, TRIAL_DAYS } from "@/lib/plans";

export const metadata = {
  title: "OnPoint – Dispensary Tracker",
  description: "Know what happened on every shift. Without counting everything, every night.",
};

// Every feature here must be live in the app. Keep it short: one line each.
const FEATURES: { group: string; items: { t: string; d: string; isNew?: boolean }[] }[] = [
  {
    group: "Stock checks staff can keep up with",
    items: [
      { t: "Spot-checks, not full counts", d: "OnPoint selects about 12 products per close. It checks a mix of random products, products with recent differences and products due for a check. Every product is checked within the schedule you set.", isNew: true },
      { t: "Checks shared between staff", d: "OnPoint shares the list between staff on shift. Everyone gets different products to check.", isNew: true },
      { t: "Weigh the whole jar", d: "Enter the empty jar’s weight once. Staff weigh the full jar and enter the reading. OnPoint subtracts the jar’s weight.", isNew: true },
      { t: "Blind counts", d: "Staff count without seeing the expected stock. If a count needs changing, they recount and give a reason. The original count stays on record." },
    ],
  },
  {
    group: "A clear record of every shift",
    items: [
      { t: "Staff confirmation", d: "Each person answers three short questions, takes photos of the scale readings and cash drawer, and confirms with their own PIN.", isNew: true },
      { t: "Cash and card checks", d: "OnPoint checks cash and card totals against the till every shift, even when only a few products are counted." },
      { t: "Differences to review", d: "When something doesn’t tally, it stays open until someone records a reason or explains what happened. A manager reviews the shift." },
      { t: "Fair to your team", d: "OnPoint shows differences without blaming anyone. Staff see their own figures; managers and owners can see the full shift." },
    ],
  },
  {
    group: "Works with the way you sell",
    items: [
      { t: "Works with your till", d: "Use Loyverse? Connect it once and sales come in by themselves at close. Any other till: upload its sales report in CSV or Excel and OnPoint remembers your layout. No till report? OnPoint works out sales from stock counts.", isNew: true },
      { t: "Fixed-price bags", d: "If you sell 2 g for R50 but allow a little extra, set the bag size and the extra amount allowed. OnPoint flags amounts above that allowance.", isNew: true },
      { t: "Special offers checked separately", d: "Deals such as “any 2 pre-rolls for R200” are tracked separately, including the items sold and the amount charged." },
      { t: "No app to install", d: "Open OnPoint in a browser on any phone, tablet or computer. Everyone signs in with their own account." },
    ],
  },
  {
    group: "What the owner gets",
    items: [
      { t: "Nightly email", d: "Get a summary when a shift closes, including whether everything tallied, what needs checking and a link to the staff photos." },
      { t: "One clear shift report", d: "See stock, cash and card totals together, with simple explanations of any differences." },
      { t: "Monthly report", d: "See what sells, when it sells, which products repeatedly come up short and what may need attention." },
      { t: "Your data stays yours", d: "Only people you approve can access your shop. You can request an export or deletion of your data." },
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
        <p className="small" style={{ margin: "24px 0 0", fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--ink-soft)" }}>Stock and cash checks for dispensaries</p>
        <h1 style={{ fontSize: 36, margin: "6px 0 10px", lineHeight: 1.15 }}>Know what happened on every shift. Without counting everything, every night.</h1>
        <p className="lede" style={{ fontSize: 18 }}>
          Your till records what was sold. OnPoint checks sales against the stock and cash left at each shift change. If something doesn’t add up, it shows you what needs checking.
        </p>

        <form action="/demo" method="get" className="sheet" style={{ borderWidth: 2 }}>
          <label htmlFor="b" style={{ marginTop: 0, fontSize: 17 }}>Your dispensary’s name</label>
          <input id="b" name="b" required maxLength={80} placeholder="e.g. Green Leaf Club" autoComplete="organization" />
          <div style={{ marginTop: 12 }}>
            <button type="submit" style={{ width: "100%" }}>See how it works</button>
          </div>
          <p className="muted small" style={{ margin: "10px 0 0" }}>Try a sample shift using example figures. No sign-up needed.</p>
        </form>

        <h2>How a shift works</h2>
        <ol className="howto">
          <li><strong>Open.</strong> Count the starting cash. Stock carries over from the last close, so you don’t have to count everything again.</li>
          <li><strong>Close.</strong> Upload your till report. Staff check their assigned products, answer three short questions, take photos and confirm their checks.</li>
          <li><strong>Know.</strong> See whether everything tallies or what needs your attention.</li>
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

        <Compare />

        <div className="sheet" style={{ marginTop: 28, borderWidth: 2 }}>
          <h2 style={{ marginTop: 0 }}>Try it free</h2>
          <p style={{ marginTop: 0 }}>
            Try everything free for {TRIAL_DAYS} days, with no card required. Then choose a plan from R{from} per month.
            Subscribe before your trial ends to get {LAUNCH_DISCOUNT.pct}% off your first {LAUNCH_DISCOUNT.months} months.
          </p>
          <Link href="/signup" className="button" style={{ width: "100%" }}>Start my free {TRIAL_DAYS} days</Link>
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
