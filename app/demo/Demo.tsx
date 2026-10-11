"use client";

// Open demo: a sample shift with the visitor's business name on it.
// Same sums as the real app, worked out in the browser. Nothing is saved.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LAUNCH_DISCOUNT, PLANS, TRIAL_DAYS } from "@/lib/plans";
import { SampleReport } from "@/components/SampleReport";
import { PlanCards } from "@/components/PlanCards";

type Unit = "g" | "each";
interface Product { id: string; group: string; name: string; unit: Unit; price: number; last: number; received: number; normal: number; special: number; counted: number | null; low: number }
interface Special { id: string; name: string; dealPrice: number; per: number; normalEach: number; deals: number; mix: Record<string, number> }

const START: [string, string, Unit, number, number, number, number, number][] = [
  // group, name, unit, price, last shift count, sold at normal price, counted now, low-stock level
  ["Flower", "Outdoor flower", "g", 25, 120, 40, 80, 30],
  ["Flower", "Greenhouse flower", "g", 50, 50, 15, 34, 20],
  ["Flower", "Indoor A flower", "g", 80, 40, 10, 30, 15],
  ["Flower", "Indoor AAA flower", "g", 120, 30, 10, 17, 15],
  ["Pre-rolls", "Indoor pre-roll: Blue Dream", "each", 100, 4, 2, 6, 5],
  ["Pre-rolls", "Indoor pre-roll: OG Kush", "each", 100, 10, 1, 4, 5],
  ["Pre-rolls", "Indoor pre-roll: Lemon Haze", "each", 100, 8, 1, 4, 5],
  ["Pre-rolls", "Greenhouse pre-roll: Gelato", "each", 50, 20, 2, 7, 5],
  ["Pre-rolls", "Greenhouse pre-roll: Cheese", "each", 50, 15, 1, 6, 5],
  ["Edibles", "Gummies 10 pack", "each", 130, 15, 5, 10, 5],
  ["Edibles", "Brownie", "each", 120, 10, 3, 6, 4],
  ["Vapes & extracts", "1ml vape cartridge", "each", 300, 8, 2, 6, 3],
  ["Vapes & extracts", "Rosin 1g", "each", 600, 5, 1, 4, 5],
];
const SPECIALS: Special[] = [
  { id: "s1", name: "Indoor pre-rolls, 2 for R180", dealPrice: 180, per: 2, normalEach: 100, deals: 7,
    mix: { "Indoor pre-roll: Blue Dream": 6, "Indoor pre-roll: OG Kush": 5, "Indoor pre-roll: Lemon Haze": 3 } },
  { id: "s2", name: "Greenhouse pre-rolls, 2 for R90", dealPrice: 90, per: 2, normalEach: 50, deals: 9,
    mix: { "Greenhouse pre-roll: Gelato": 11, "Greenhouse pre-roll: Cheese": 8 } },
];
const TILL_CARD = 3200;
const FLOAT = 500;
const USUAL_DAY = 8800;

const freshProducts = (): Product[] =>
  START.map(([group, name, unit, price, last, normal, counted, low], i) => ({
    id: `p${i}`, group, name, unit, price, last, received: 0, normal,
    special: SPECIALS.reduce((a, s) => a + (s.mix[name] ?? 0), 0), counted, low,
  }));

const t10 = (v: number) => Math.round(v * 10);
function rand(v: number, signed = false) {
  const n = Math.round(v);
  const s = `R${Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;
  if (!signed) return (n < 0 ? "−" : "") + s;
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}
function qty(v: number | null, unit: Unit, signed = false) {
  if (v === null) return "—";
  const n = Math.round(v * 10) / 10;
  const sign = signed ? (n > 0 ? "+" : n < 0 ? "−" : "") : n < 0 ? "−" : "";
  return unit === "g" ? `${sign}${Math.abs(n)}g` : `${sign}${Math.abs(n)}`;
}

function calc(products: Product[], cashCounted: number, cardMachine: number) {
  const rows = products.map((p) => {
    const sold = p.normal + p.special;
    const should = (t10(p.last) + t10(p.received) - t10(sold)) / 10;
    const diff = p.counted === null ? null : (t10(p.counted) - t10(should)) / 10;
    const specialMade = SPECIALS.reduce((a, s) => a + (s.mix[p.name] ?? 0) * (s.dealPrice / s.per), 0);
    const made = Math.round(p.normal * p.price + specialMade);
    const missingValue = diff !== null && diff < 0 ? Math.round(-diff * p.price) : 0;
    return { ...p, sold, should, diff, made, specialMade: Math.round(specialMade), missingValue, minus: should < 0, lowNext: p.counted !== null && p.counted <= p.low };
  });
  const specials = SPECIALS.map((s) => {
    const units = Object.values(s.mix).reduce((a, v) => a + v, 0);
    const shouldUnits = s.deals * s.per;
    const items = Object.entries(s.mix).map(([name, n]) => ({ name, n, row: rows.find((r) => r.name === name)! })).sort((a, b) => b.n - a.n);
    const taken = s.deals * s.dealPrice;
    const atNormal = Math.min(units, shouldUnits) * s.normalEach;
    return { ...s, units, shouldUnits, extra: units - shouldUnits, taken, atNormal, discount: atNormal - taken, items, normalSame: items.reduce((a, i) => a + i.row.normal, 0) };
  });
  const tillTotal = rows.reduce((a, r) => a + r.made, 0);
  const tillCash = tillTotal - TILL_CARD;
  const cashShould = FLOAT + tillCash;
  return {
    rows, specials, tillTotal, tillCash, cashShould,
    cashDiff: cashCounted - cashShould,
    cardDiff: cardMachine - TILL_CARD,
    missingTotal: rows.reduce((a, r) => a + r.missingValue, 0),
    specialTaken: specials.reduce((a, s) => a + s.taken, 0),
    specialUnits: specials.reduce((a, s) => a + s.units, 0),
    specialDiscount: specials.reduce((a, s) => a + s.discount, 0),
  };
}
type Calc = ReturnType<typeof calc>;
interface Alert { id: string; level: "variance" | "pending"; title: string; amount: string; body: string; actions: [string, string][] }

function alertsFor(c: Calc, closedBy: string): Alert[] {
  const list: Alert[] = [];
  const missing = c.rows.filter((r) => r.diff !== null && r.diff < 0);
  if (missing.length) list.push({ id: "stock", level: "variance", title: "Stock and money don’t tally", amount: rand(c.missingTotal),
    body: `Stock is missing that was never rung up: ${missing.map((r) => `${r.name} ${qty(-r.diff!, r.unit)}`).join(", ")}. At your selling prices that is worth ${rand(c.missingTotal)}.`,
    actions: [["recount", "Ask staff to recount"], ["explain", "Write what happened"]] });
  c.specials.filter((s) => s.extra !== 0).forEach((s) => list.push({ id: `sp-${s.id}`, level: "variance", title: "A special doesn’t tally", amount: `${s.extra > 0 ? "+" : "−"}${Math.abs(s.extra)}`,
    body: `${s.name}: ${s.deals} deals should mean ${s.shouldUnits} pre-rolls went out, but ${s.units} did. ${s.extra > 0 ? `${s.extra} extra, worth ${rand(s.extra * s.normalEach)} at the normal price.` : ""}`,
    actions: [["specials", "See the special"], ["explain", "Write what happened"]] }));
  if (c.cashDiff !== 0) list.push({ id: "cash", level: "variance", title: c.cashDiff < 0 ? "Cash short in the till" : "Extra cash in the till", amount: rand(c.cashDiff, true),
    body: `The till says there should be ${rand(c.cashShould)} in cash (${rand(FLOAT)} float plus ${rand(c.tillCash)} cash sales). ${closedBy} counted ${rand(c.cashShould + c.cashDiff)}.`,
    actions: [["recount", "Ask for a recount"], ["explain", "Write what happened"]] });
  if (c.cardDiff !== 0) list.push({ id: "card", level: "variance", title: "Card machine doesn’t match the till", amount: rand(c.cardDiff, true),
    body: `The till recorded ${rand(TILL_CARD)} in card sales. The card machine shows ${rand(TILL_CARD + c.cardDiff)}.`, actions: [["explain", "Write what happened"]] });
  c.rows.filter((r) => r.minus).forEach((r) => list.push({ id: `minus-${r.id}`, level: "variance", title: `${r.name} went into minus`, amount: qty(r.should, r.unit, true),
    body: `The till sold ${qty(r.sold, r.unit)} but only ${qty(r.last + r.received, r.unit)} was in stock. Usually a delivery came in and wasn’t logged.`,
    actions: [[`delivery:${r.id}`, "Log the missing delivery"], ["explain", "Write what happened"]] }));
  c.rows.filter((r) => r.lowNext).forEach((r) => list.push({ id: `low-${r.id}`, level: "pending", title: `Running low: ${r.name}`, amount: qty(r.counted, r.unit),
    body: `Only ${qty(r.counted, r.unit)} left for the next shift. You asked to be warned at ${qty(r.low, r.unit)}.`, actions: [["ok", "Noted, I’ll reorder"]] }));
  return list;
}

const groups = <T extends { group: string }>(rows: T[]) => [...new Set(rows.map((r) => r.group))].map((g) => [g, rows.filter((r) => r.group === g)] as const);
const TABS = [["alerts", "Alerts"], ["specials", "Today’s specials"], ["last", "Last shift stock"], ["now", "In stock now"], ["made", "What each product made"], ["next", "Stock for next shift"], ["report", "Monthly report"]] as const;
type Tab = (typeof TABS)[number][0];

export default function Demo({ businessName }: { businessName: string }) {
  const [products, setProducts] = useState(freshProducts);
  const [cashCounted, setCashCounted] = useState<number | null>(null);
  const [cardMachine, setCardMachine] = useState(TILL_CARD);
  const [view, setView] = useState<"owner" | "staff">("owner");
  const [tab, setTab] = useState<Tab>("alerts");
  const [fixed, setFixed] = useState<Record<string, string>>({});
  const [explaining, setExplaining] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // A link ending in #report opens the sample monthly report straight away
  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (TABS.some(([k]) => k === h)) setTab(h as Tab);
  }, []);

  const base = useMemo(() => calc(products, 0, cardMachine), [products, cardMachine]);
  const cash = cashCounted ?? base.cashShould - 110; // sample: R110 short
  const c = useMemo(() => calc(products, cash, cardMachine), [products, cash, cardMachine]);
  const alerts = alertsFor(c, "Thandi");
  const open = alerts.filter((a) => !fixed[a.id]);

  const say = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 2600); };
  function act(a: Alert, how: string) {
    if (how === "explain") { setExplaining(a.id); setNote(""); return; }
    if (how === "specials") { setTab("specials"); return; }
    if (how === "recount") { setView("staff"); window.scrollTo(0, 0); say("You’re now the staff member. Recount and submit again."); return; }
    if (how === "ok") { setFixed({ ...fixed, [a.id]: "Noted. Reorder planned." }); return; }
    if (how.startsWith("delivery:")) {
      const id = how.split(":")[1];
      setProducts(products.map((p) => (p.id === id ? { ...p, received: 10 } : p)));
      say("Logged a delivery of 10. The minus is gone.");
    }
  }
  function submitStaff(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const next = products.map((p) => {
      const v = String(f.get(`c-${p.id}`) ?? "").trim();
      return { ...p, counted: v === "" ? null : Number(v) };
    });
    const cashV = Number(f.get("cash")), cardV = Number(f.get("card"));
    if (next.some((p) => p.counted !== null && (Number.isNaN(p.counted) || p.counted < 0)) || Number.isNaN(cashV) || Number.isNaN(cardV)) return say("Use numbers only, like 34 or 2.5.");
    setProducts(next); setCashCounted(cashV); setCardMachine(cardV);
    const after = calc(next, cashV, cardV);
    const bad = alertsFor(after, "Thandi").filter((a) => a.level === "variance");
    setFixed({}); setView("owner"); setTab("alerts"); window.scrollTo(0, 0);
    setBanner(bad.length ? `${businessName}: shift doesn’t tally. ${bad.length} problem${bad.length === 1 ? "" : "s"}${after.missingTotal ? `, ${rand(after.missingTotal)} of stock missing` : ""}${after.cashDiff ? `, cash ${rand(after.cashDiff, true)}` : ""}.` : `${businessName}: shift closed. Stock and money tally.`);
  }

  const signup = `/signup?b=${encodeURIComponent(businessName)}`;

  return (
    <>
      <div style={{ background: "var(--ink)", color: "var(--paper)", fontSize: 14, padding: "8px 16px", textAlign: "center" }}>
        Sample shift with made-up figures. <a href="#prices" style={{ color: "var(--paper)", fontWeight: 700 }}>See prices</a> · <Link href={signup} style={{ color: "var(--paper)", fontWeight: 700 }}>Start free</Link>
      </div>
      <header className="topbar">
        <Link href="/" className="brand" style={{ textDecoration: "none" }}>On<b>Point</b></Link>
        <nav className="nav"><a href="#prices">Prices</a><Link href="/faq">Questions</Link><Link href="/login">Sign in</Link></nav>
      </header>
      <main className="wrap">
        <h1 style={{ marginTop: 8 }}>{businessName}</h1>
        <p className="muted" style={{ marginTop: 0 }}>Shift closed at 18:02 by Thandi</p>

        {banner && (
          <div className="sheet" role="status" style={{ borderWidth: 2, borderColor: "var(--ink)" }}>
            <p className="small muted" style={{ margin: 0 }}>Example email alert to the owner</p>
            <p style={{ margin: "4px 0 8px", fontWeight: 700 }}>{banner}</p>
            <button type="button" className="quiet" onClick={() => setBanner(null)}>Close</button>
          </div>
        )}

        <div className="nav" role="group" aria-label="Whose view" style={{ margin: "8px 0" }}>
          <button type="button" className={view === "owner" ? "" : "quiet"} onClick={() => setView("owner")}>Owner</button>
          <button type="button" className={view === "staff" ? "" : "quiet"} onClick={() => setView("staff")}>Staff closing the shift</button>
        </div>

        {view === "owner" && (
          <>
            <nav className="nav" aria-label="Owner screens" style={{ margin: "12px 0" }}>
              {TABS.map(([k, l]) => (
                <a key={k} href={`#${k}`} aria-current={tab === k ? "page" : undefined} onClick={(e) => { e.preventDefault(); setTab(k); }}>
                  {l}{k === "alerts" && open.length ? ` (${open.length})` : ""}
                </a>
              ))}
            </nav>

            {tab === "alerts" && (
              <>
                <div className="figures">
                  <div className="figure"><div className="value">{rand(c.tillTotal)}</div><div className="label">Sold on the till</div></div>
                  <div className="figure"><div className="value" style={{ color: `var(--${c.missingTotal ? "variance" : "matched"})` }}>{rand(c.missingTotal)}</div><div className="label">Missing stock value</div></div>
                  <div className="figure"><div className="value" style={{ color: `var(--${c.cashDiff ? "variance" : "matched"})` }}>{rand(c.cashDiff, true)}</div><div className="label">Cash difference</div></div>
                  <div className="figure"><div className="value">{rand(c.specialTaken)}</div><div className="label">Taken on specials</div></div>
                </div>
                {!open.length && <p className="notice ok"><strong>Stock and money tally.</strong> Nothing needs your attention.</p>}
                {alerts.map((a) => {
                  const done = fixed[a.id];
                  return (
                    <div key={a.id} className="sheet" style={{ borderLeft: `6px solid var(--${done ? "matched" : a.level})` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                        <h3>{a.title}</h3>
                        <span className="diff" data-status={done ? "matched" : a.level === "pending" ? "pending" : "variance"} style={{ fontSize: 22 }}>{a.amount}</span>
                      </div>
                      <p className="small muted" style={{ margin: "4px 0 8px" }}>{a.body}</p>
                      {done ? <p className="small" style={{ color: "var(--matched)", fontWeight: 700, margin: 0 }}>{done}</p> : explaining === a.id ? (
                        <>
                          <label htmlFor={`n-${a.id}`}>What happened?</label>
                          <textarea id={`n-${a.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                          <div className="row" style={{ marginTop: 8 }}>
                            <button type="button" onClick={() => { if (!note.trim()) return say("Write what happened first."); setFixed({ ...fixed, [a.id]: `Explained: “${note.trim()}”` }); setExplaining(null); }}>Save and close alert</button>
                          </div>
                        </>
                      ) : (
                        <div className="row" style={{ flexWrap: "wrap" }}>
                          {a.actions.map(([k, l], i) => <button key={k} type="button" className={i ? "quiet" : ""} onClick={() => act(a, k)}>{l}</button>)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {tab === "specials" && (
              <>
                <p className="muted small">Each special is tallied on its own: what sold, the mix people chose, and what it did to stock and takings.</p>
                <div className="figures">
                  <div className="figure"><div className="value">{rand(c.specialTaken)}</div><div className="label">Taken on specials ({Math.round((c.specialTaken / c.tillTotal) * 100)}% of today)</div></div>
                  <div className="figure"><div className="value">{c.specialUnits}</div><div className="label">Items out on specials</div></div>
                  <div className="figure"><div className="value" style={{ color: "var(--pending)" }}>{rand(c.specialDiscount)}</div><div className="label">Given away in discount</div></div>
                  <div className="figure"><div className="value" style={{ color: `var(--${c.tillTotal >= USUAL_DAY ? "matched" : "variance"})` }}>{rand(c.tillTotal - USUAL_DAY, true)}</div><div className="label">Compared with a usual day</div></div>
                </div>
                {c.specials.map((s) => (
                  <div key={s.id} className="sheet">
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                      <h3>{s.name}</h3>
                      <span className="status" data-status={s.extra ? "variance" : "matched"}>{s.extra ? "Doesn’t tally" : "Tallies"}</span>
                    </div>
                    <p className="small muted" style={{ margin: "4px 0 10px" }}>{s.deals} deals sold, so {s.shouldUnits} items should have gone out. {s.units} did{s.extra ? `: ${Math.abs(s.extra)} ${s.extra > 0 ? "extra" : "short"}` : ""}.</p>
                    <ul className="lines">
                      {s.items.map((it, i) => (
                        <li key={it.name} className="line">
                          <span className="name">{it.name}{i === 0 ? " (most picked)" : ""}</span>
                          <span className="diff" style={{ fontSize: 20 }}>{it.n}</span>
                          <span className="meta">{Math.round((it.n / s.units) * 100)}% of the deal. {qty(it.row.counted, "each")} left{it.row.lowNext ? ", running low" : ""}</span>
                        </li>
                      ))}
                    </ul>
                    <table className="working" style={{ marginTop: 10 }}><tbody>
                      <tr><td>Taken for {s.deals} deals</td><td>{rand(s.taken)}</td></tr>
                      <tr><td>Same {Math.min(s.units, s.shouldUnits)} items at the normal {rand(s.normalEach)}</td><td>{rand(s.atNormal)}</td></tr>
                      <tr><td>Discount given</td><td>{rand(s.discount)}</td></tr>
                      {s.extra > 0 && <tr><td>Extra items not paid for</td><td style={{ color: "var(--variance)" }}>{s.extra} ({rand(s.extra * s.normalEach)})</td></tr>}
                      <tr className="total"><td>These items sold today, all prices</td><td>{s.units + s.normalSame}</td></tr>
                    </tbody></table>
                  </div>
                ))}
                <h2>What the specials did to the day</h2>
                <div className="sheet"><table className="working"><tbody>
                  <tr><td>Total taken today</td><td>{rand(c.tillTotal)}</td></tr>
                  <tr><td>From specials</td><td>{rand(c.specialTaken)}</td></tr>
                  <tr><td>From everything else</td><td>{rand(c.tillTotal - c.specialTaken)}</td></tr>
                  <tr><td>Usual day without specials</td><td>{rand(USUAL_DAY)}</td></tr>
                  <tr className="total"><td>Today compared with a usual day</td><td>{rand(c.tillTotal - USUAL_DAY, true)}</td></tr>
                </tbody></table></div>
              </>
            )}

            {tab === "last" && (
              <>
                <p className="muted small">What was on the shelf when the shift started, plus deliveries during the shift.</p>
                {groups(c.rows).map(([g, rows]) => (
                  <div key={g}><h3 style={{ margin: "16px 0 6px" }}>{g}</h3><ul className="lines">
                    {rows.map((r) => <li key={r.id} className="line"><span className="name">{r.name}</span><span className="diff" style={{ fontSize: 20 }}>{qty(r.last, r.unit)}</span>{r.received ? <span className="meta">+ {qty(r.received, r.unit)} delivered</span> : null}</li>)}
                  </ul></div>
                ))}
              </>
            )}

            {tab === "now" && (
              <>
                <p className="muted small">What staff counted at close, next to what should be there. Should have = last shift stock + deliveries − what the till sold.</p>
                {groups(c.rows).map(([g, rows]) => (
                  <div key={g}><h3 style={{ margin: "16px 0 6px" }}>{g}</h3><ul className="lines">
                    {rows.map((r) => {
                      const st = r.minus || (r.diff !== null && r.diff < 0) ? "variance" : r.diff === null ? "missing_evidence" : r.diff > 0 ? "pending" : "matched";
                      return (
                        <li key={r.id} className="line" data-status={st}>
                          <span className="name">{r.name}</span>
                          <span className="diff" data-status={st} style={{ fontSize: 20 }}>{r.diff === null ? "Not counted" : r.diff === 0 ? "Tallies" : qty(r.diff, r.unit, true)}</span>
                          <span className="meta">Counted {qty(r.counted, r.unit)}, should have {qty(r.should, r.unit)}{r.missingValue ? `. Worth ${rand(r.missingValue)}` : ""}{r.minus ? ". Went into minus" : ""}</span>
                        </li>
                      );
                    })}
                  </ul></div>
                ))}
              </>
            )}

            {tab === "made" && (
              <>
                <p className="muted small">Money each product brought in on the till, best seller first.</p>
                <ul className="lines">
                  {[...c.rows].sort((a, b) => b.made - a.made).map((r) => (
                    <li key={r.id} className="line"><span className="name">{r.name}</span><span className="diff" style={{ fontSize: 20 }}>{rand(r.made)}</span>
                      <span className="meta">{r.special ? `${r.normal} at ${rand(r.price)} plus ${r.special} on special (${rand(r.specialMade)})` : `${qty(r.normal, r.unit)} sold at ${rand(r.price)}${r.unit === "g" ? " a gram" : " each"}`}</span></li>
                  ))}
                </ul>
                <h2>Does the money tally?</h2>
                <div className="sheet"><table className="working"><tbody>
                  <tr><td>Total sold on the till</td><td>{rand(c.tillTotal)}</td></tr>
                  <tr><td>Paid by card</td><td>{rand(TILL_CARD)}</td></tr>
                  <tr><td>Paid in cash</td><td>{rand(c.tillCash)}</td></tr>
                  <tr><td>Plus the float</td><td>{rand(FLOAT)}</td></tr>
                  <tr className="total"><td>Cash that should be in the till</td><td>{rand(c.cashShould)}</td></tr>
                  <tr><td>Cash counted</td><td>{rand(cash)}</td></tr>
                  <tr><td>Cash difference</td><td style={{ color: `var(--${c.cashDiff ? "variance" : "matched"})` }}>{rand(c.cashDiff, true)}</td></tr>
                  <tr><td>Card machine total</td><td>{rand(cardMachine)}</td></tr>
                  <tr><td>Card difference</td><td style={{ color: `var(--${c.cardDiff ? "variance" : "matched"})` }}>{rand(c.cardDiff, true)}</td></tr>
                </tbody></table></div>
                {c.missingTotal > 0 && <p className="small muted">The till and cash can match while stock still disappears, when a sale is never rung up or stock is taken. That’s why OnPoint also values the missing stock: {rand(c.missingTotal)} this shift.</p>}
              </>
            )}

            {tab === "report" && <SampleReport businessName={businessName} />}

            {tab === "next" && (
              <>
                <p className="muted small">What the next shift starts with. Their opening count is checked against these numbers.</p>
                {groups(c.rows).map(([g, rows]) => (
                  <div key={g}><h3 style={{ margin: "16px 0 6px" }}>{g}</h3><ul className="lines">
                    {rows.map((r) => <li key={r.id} className="line" data-status={r.lowNext ? "pending" : undefined}><span className="name">{r.name}</span><span className="diff" data-status={r.lowNext ? "pending" : undefined} style={{ fontSize: 20 }}>{qty(r.counted, r.unit)}</span>{r.lowNext ? <span className="meta">Running low. Warn level {qty(r.low, r.unit)}</span> : null}</li>)}
                  </ul></div>
                ))}
              </>
            )}
          </>
        )}

        {view === "staff" && (
          <form onSubmit={submitStaff}>
            <h2>Close the shift</h2>
            <p className="muted small">Count what’s on the shelf. Staff don’t see what the system expects, so counts stay honest. Weighed items are in grams.</p>
            {groups(products).map(([g, rows]) => (
              <div key={g}><h3 style={{ margin: "16px 0 6px" }}>{g}</h3><ul className="lines">
                {rows.map((p) => (
                  <li key={p.id} className="line">
                    <label htmlFor={`c-${p.id}`} className="name" style={{ margin: 0 }}>{p.name}</label>
                    <input id={`c-${p.id}`} name={`c-${p.id}`} type="number" inputMode="decimal" step="0.1" min="0" defaultValue={p.counted ?? ""} style={{ width: 110 }} />
                  </li>
                ))}
              </ul></div>
            ))}
            <div className="sheet">
              <label htmlFor="cash" style={{ marginTop: 0 }}>Cash counted in the till (R)</label>
              <input id="cash" name="cash" type="number" inputMode="decimal" defaultValue={cash} />
              <label htmlFor="card">Card machine end-of-day total (R)</label>
              <input id="card" name="card" type="number" inputMode="decimal" defaultValue={cardMachine} />
              <div style={{ marginTop: 12 }}><button type="submit" style={{ width: "100%" }}>Submit and close shift</button></div>
              <p className="muted small" style={{ marginBottom: 0 }}>Try it: change a count or the cash, then submit and watch the owner’s alerts change.</p>
            </div>
          </form>
        )}

        <PlanCards signup={signup} name={businessName === "Your dispensary" ? "" : businessName} />

        <div className="sheet" style={{ marginTop: 28, borderWidth: 2 }}>
          <h2 style={{ marginTop: 0 }}>Use OnPoint at {businessName}</h2>
          <p>{TRIAL_DAYS} days of everything free, then from R{PLANS[1].price} a month. Subscribe before your trial ends and your first {LAUNCH_DISCOUNT.months} months are {LAUNCH_DISCOUNT.pct}% off.</p>
          <Link href={signup} className="button" style={{ width: "100%" }}>Start free</Link>
          {tab !== "report" && <button type="button" className="quiet" style={{ width: "100%", marginTop: 10 }} onClick={() => { setView("owner"); setTab("report"); window.scrollTo(0, 0); }}>See a sample monthly report</button>}
          <p className="small muted" style={{ marginBottom: 0 }}><button type="button" className="quiet" style={{ marginTop: 10 }} onClick={() => { setProducts(freshProducts()); setCashCounted(null); setCardMachine(TILL_CARD); setFixed({}); setBanner(null); setView("owner"); setTab("alerts"); }}>Start the demo again</button></p>
        </div>
      </main>
      {toast && <div role="status" style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 24, background: "var(--ink)", color: "var(--paper)", padding: "10px 16px", borderRadius: 999, fontSize: 15, zIndex: 20, maxWidth: "calc(100% - 32px)", textAlign: "center" }}>{toast}</div>}
    </>
  );
}
