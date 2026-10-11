import Link from "next/link";
import { LAUNCH_DISCOUNT, PLANS, TRIAL_DAYS } from "@/lib/plans";

// Questions shop owners actually ask, in their words. Shown on /faq (public
// and inside the app). Keep every answer true to what the app does today.

export const WHATSAPP = "27696425639";
const rand = (n: number) => `R${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;
const paid = PLANS.filter((p) => p.price > 0);

const QA: { group: string; items: { q: string; a: React.ReactNode }[] }[] = [
  {
    group: "“We already have a system”",
    items: [
      {
        q: "My till already does our stock take. Why pay for another app to tell me what’s short?",
        a: (
          <>
            <p>If your till already checks stock <em>and</em> cash at every handover, and someone reads those reports every day, you may not need OnPoint, and that’s fine.</p>
            <p>Most tills record what was sold. OnPoint is the check on top of that, at every handover:</p>
            <ul>
              <li>what the till says was sold, against what’s left on the shelf;</li>
              <li>the cash and card taken, against what the till says came in;</li>
              <li>one plain answer for the owner, even when they’re not on site: everything tallied, or which product or how much money to look at.</li>
            </ul>
            <p>It works alongside your till; it doesn’t replace it.</p>
          </>
        ),
      },
      {
        q: "Will it get the sales from my existing POS?",
        a: <p>Yes, from the till’s sales export. If your till can save its sales as a CSV or Excel file, OnPoint reads it, whatever the layout. The first time, it asks which column is which and which till item is which product, then remembers. It doesn’t connect to tills directly yet, so someone uploads the file at close. No till? Staff count at open and close, and OnPoint works out what was sold from the counts.</p>,
      },
      {
        q: "Everyone enters their counts and our system prints a report. What does OnPoint give me?",
        a: (
          <ul>
            <li>A shift summary as soon as the shift closes: what tallied, what didn’t, and by how much. Print it or save it as a PDF from your browser.</li>
            <li>An email to the owner when a shift doesn’t tally (Starter plan and up).</li>
            <li>A monthly report: what sells and when, stock to keep an eye on, and what to do next (Business plan).</li>
          </ul>
        ),
      },
    ],
  },
  {
    group: "Counting stock",
    items: [
      {
        q: "We have 70+ products. We can’t count everything every day.",
        a: <p>You don’t have to. Switch on spot-checks and OnPoint picks a short list for each close (12 products by default, and you choose the number). It mixes products at random with ones that didn’t tally recently and ones that haven’t been checked for a while. Everything else carries forward from the till sales, and every product still gets counted within the number of days you set. The cash is checked every shift.</p>,
      },
      {
        q: "We sell 2g for R50, but the bag usually has 2.2g in it. Won’t that look like missing stock?",
        a: <p>Not if it’s within your allowance. Tell OnPoint each sale is a 2g bag (it suggests this from item names like “Gelato 2g”) and allow, say, 10% extra. A 2.2g bag then won’t raise an alert. If more than that leaves the jar, the alert shows how much extra went out compared with what was sold.</p>,
      },
      {
        q: "Do staff have to take the flower out of the jar to weigh it?",
        a: <p>No. Enter each empty jar’s weight once. Staff put the whole jar on the scale and type in the reading, and OnPoint takes off the jar.</p>,
      },
      {
        q: "We split the stock take randomly between staff so nobody can hustle. Can OnPoint do that?",
        a: (
          <>
            <p>Partly, today:</p>
            <ul>
              <li>On spot-checks, nobody knows in advance which products will be counted.</li>
              <li>Staff count without seeing what the system expects.</li>
              <li>Every count is saved under the name of the person who entered it.</li>
              <li>A recount adds a new version with a reason; the first count is never overwritten.</li>
              <li>A manager signs off each shift.</li>
            </ul>
            <p>Sharing the list out at random between everyone on shift, so each person counts something different every time, is the next thing we’re building.</p>
          </>
        ),
      },
    ],
  },
  {
    group: "Your team",
    items: [
      {
        q: "Will my staff feel accused?",
        a: <p>OnPoint shows differences, not blame. When something doesn’t tally, staff pick a likely reason (a counting mistake, spillage, a staff sample, a delivery not logged) and can add a note. You decide what happens next. Most differences turn out to be honest mistakes, and catching them early stops them growing.</p>,
      },
      {
        q: "Who sees what?",
        a: <p>Staff see their shop’s shifts, but the money figures only for shifts they worked. Managers and the owner see everything, including alerts and reports. Only people you add can see your shop.</p>,
      },
      {
        q: "Is there an app to install?",
        a: <p>No. It runs in the browser on any phone, tablet or computer. Each staff member signs in with their own login.</p>,
      },
    ],
  },
  {
    group: "Price and sign-up",
    items: [
      {
        q: "What does it cost?",
        a: (
          <>
            <p>{paid.map((p) => `${p.name} ${rand(p.price)} a month`).join(", ")}. There’s also a Free plan for one shop with up to 15 products.</p>
            <p>Subscribe before your free trial ends and your first {LAUNCH_DISCOUNT.months} months are {LAUNCH_DISCOUNT.pct}% off. <Link href="/pricing">See what each plan includes</Link>.</p>
          </>
        ),
      },
      {
        q: "Can I try it first?",
        a: <p>Yes: {TRIAL_DAYS} days free with everything switched on, no card needed. After that you can stay on the Free plan or choose a paid one. It’s month to month, and you can cancel any time.</p>,
      },
      {
        q: "How long does it take to set up?",
        a: <p>Upload your product list from a spreadsheet (any layout) and add your staff. A short checklist on the first screen walks you through the rest, and your first shift can start the same day.</p>,
      },
      {
        q: "What happens to my data?",
        a: <p>It’s yours. Ask us at any time and we’ll export it for you or delete it.</p>,
      },
    ],
  },
];

export function Faq({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <h1>Questions</h1>
      <p className="lede">Your till knows what was sold. OnPoint checks it against what’s left on the shelf and in the till, at every handover.</p>

      {QA.map((g, i) => (
        <section key={g.group} aria-labelledby={`faq-g${i}`}>
          <h2 id={`faq-g${i}`}>{g.group}</h2>
          {g.items.map((it) => (
            <details key={it.q} className="sheet faq">
              <summary>{it.q}</summary>
              <div className="faq-a">{it.a}</div>
            </details>
          ))}
        </section>
      ))}

      <div className="sheet" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>Still have a question?</h2>
        <p>Message us on WhatsApp and a person will reply.</p>
        <a className="button" href={`https://wa.me/${WHATSAPP}`} style={{ width: "100%" }}>WhatsApp +27 69 642 5639</a>
        {!signedIn && (
          <p className="small" style={{ marginTop: 10 }}>
            <Link href="/demo">Try the demo</Link> · <Link href="/signup">Start {TRIAL_DAYS} days free</Link>
          </p>
        )}
      </div>
    </>
  );
}
