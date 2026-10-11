"use client";

// The owner's view of a closed shift, in plain words: Alerts, Today's specials,
// Last shift stock, In stock now, What each product made, Stock for next shift.
// Every figure comes from the database reconciliation; nothing is recalculated here.
import { useState } from "react";
import Decimal from "decimal.js";
import { formatQty, formatZar } from "@/lib/calculations";
import { ActionForm, Submit } from "@/components/ActionForm";
import { updateException } from "@/app/actions";
import { ReasonFields } from "@/components/ReasonFields";
import { EXCEPTION_TYPE } from "@/lib/labels";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ShiftException {
  id: string; exception_type: string; status: string; severity: string;
  expected: string | null; actual: string | null; difference: string | null; explanation: string | null;
  product_name: string | null; base_unit: string | null; payment_method: string | null;
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const signedQty = (v: unknown, unit: string) => {
  const x = n(v);
  if (x === null) return "—";
  return `${x > 0 ? "+" : x < 0 ? "−" : ""}${formatQty(Math.abs(x), unit)}`;
};
const signedZar = (v: unknown) => {
  const x = n(v);
  if (x === null) return "—";
  return x > 0 ? `+${formatZar(x)}` : formatZar(x);
};
const MONEY_TYPES = ["cash_variance", "settlement_variance", "sales_value_variance", "opening_float_variance"];

export function OwnerShiftView({
  recon, exceptions, prices, canResolve, closedBy, compareAllowed,
}: {
  recon: any; exceptions: ShiftException[]; prices: Record<string, string>; canResolve: boolean; closedBy: string; compareAllowed: boolean;
}) {
  const money = Boolean(recon.money_visible);
  const tabs = (money
    ? [["alerts", "Alerts"], ["specials", "Today’s specials"], ["last", "Last shift stock"], ["now", "In stock now"], ["made", "What each product made"], ["next", "Stock for next shift"]]
    : [["alerts", "Alerts"], ["last", "Last shift stock"], ["now", "In stock now"], ["next", "Stock for next shift"]]) as [string, string][];
  const [tab, setTab] = useState(tabs[0][0]);

  const stock = recon.stock as any[];
  const missing = stock
    .filter((s) => n(s.variance) !== null && n(s.variance)! < 0 && prices[s.product_id])
    .map((s) => ({ ...s, value: new Decimal(s.variance).negated().times(prices[s.product_id]).toDecimalPlaces(2).toNumber() }));
  const missingTotal = missing.reduce((a, s) => a + s.value, 0);
  const openEx = exceptions.filter((e) => e.status === "open" || e.status === "explained");
  const specials = (recon.specials ?? []) as any[];
  const specialTaken = specials.reduce((a, s) => a + Number(s.taken), 0);
  const posNet = money ? Number(recon.sales.pos_net) : 0;
  const usual = compareAllowed && recon.usual_day && Number(recon.usual_day.shifts) > 0 ? Number(recon.usual_day.average) : null;

  return (
    <>
      <nav className="nav" aria-label="Shift screens" style={{ margin: "14px 0" }}>
        {tabs.map(([k, l]) => (
          <a key={k} href={`#${k}`} aria-current={tab === k ? "page" : undefined} onClick={(e) => { e.preventDefault(); setTab(k); }}>
            {l}{k === "alerts" && openEx.length ? ` (${openEx.length})` : ""}
          </a>
        ))}
      </nav>

      {tab === "alerts" && (
        <>
          {money && (
            <div className="figures">
              <div className="figure"><div className="value">{formatZar(posNet)}</div><div className="label">Sold on the till</div></div>
              <div className="figure"><div className="value" style={{ color: `var(--${missingTotal ? "variance" : "matched"})` }}>{formatZar(missingTotal)}</div><div className="label">Missing stock value</div></div>
              <div className="figure"><div className="value" style={{ color: `var(--${recon.cash.status === "matched" ? "matched" : "variance"})` }}>{signedZar(recon.cash.variance)}</div><div className="label">Cash difference</div></div>
              <div className="figure"><div className="value">{formatZar(specialTaken)}</div><div className="label">Taken on specials</div></div>
            </div>
          )}
          {openEx.length === 0 && <p className="notice ok"><strong>Stock and money tally.</strong> Nothing needs attention for this shift.</p>}
          {exceptions.filter((e) => e.status !== "superseded").map((e) => {
            const isMoney = MONEY_TYPES.includes(e.exception_type);
            const unit = e.base_unit ?? "unit";
            const fmt = (v: unknown) => (isMoney ? formatZar(n(v)) : formatQty(n(v), unit));
            const tone = e.status === "resolved" ? "matched" : e.severity === "info" ? "pending" : "variance";
            const amount = e.exception_type === "low_stock" ? formatQty(n(e.actual), unit)
              : e.difference === null ? "" : isMoney ? signedZar(e.difference) : signedQty(e.difference, unit);
            const value = e.exception_type === "stock_variance" ? missing.find((m) => m.name === e.product_name)?.value : undefined;
            return (
              <div key={e.id} className="sheet" style={{ borderLeft: `6px solid var(--${tone})` }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                  <h3>{EXCEPTION_TYPE[e.exception_type] ?? e.exception_type}{e.product_name ? `: ${e.product_name}` : ""}{e.payment_method && !e.product_name ? ` (${e.payment_method})` : ""}</h3>
                  <span className="diff" data-status={tone} style={{ fontSize: 22 }}>{amount}</span>
                </div>
                <p className="small muted" style={{ margin: "4px 0 8px" }}>
                  {e.exception_type === "low_stock" ? `Only ${formatQty(n(e.actual), unit)} left for the next shift. Warn level ${formatQty(n(e.expected), unit)}.`
                    : e.exception_type === "went_into_minus" ? "The till sold more than was in stock. Usually a delivery came in and wasn’t logged."
                    : e.expected !== null ? `Expected ${fmt(e.expected)}, found ${fmt(e.actual)}.${value ? ` Worth ${formatZar(value)} at your selling price.` : ""}` : ""}
                </p>
                {e.explanation && <p style={{ whiteSpace: "pre-wrap", margin: "0 0 8px" }}>{e.explanation}</p>}
                {e.status === "resolved" ? <span className="status" data-status="matched">Resolved</span> : (
                  <ActionForm action={updateException} hidden={{ exception_id: e.id }}>
                    <ReasonFields id={e.id} label={"What happened?"} />
                    <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
                      <Submit className="quiet" name="status" value="explained">Save explanation</Submit>
                      {canResolve && <Submit name="status" value="resolved">Fixed, close alert</Submit>}
                    </div>
                  </ActionForm>
                )}
              </div>
            );
          })}
        </>
      )}

      {tab === "specials" && (
        <>
          {specials.length === 0 ? <p className="muted">No specials were sold this shift.</p> : (
            <>
              <div className="figures">
                <div className="figure"><div className="value">{formatZar(specialTaken)}</div><div className="label">Taken on specials{posNet ? ` (${Math.round((specialTaken / posNet) * 100)}% of the shift)` : ""}</div></div>
                <div className="figure"><div className="value">{specials.reduce((a, s) => a + Number(s.units), 0)}</div><div className="label">Items out on specials</div></div>
                <div className="figure"><div className="value" style={{ color: "var(--pending)" }}>{formatZar(specials.reduce((a, s) => a + Number(s.discount), 0))}</div><div className="label">Given away in discount</div></div>
                <div className="figure"><div className="value">{usual === null ? "—" : signedZar(posNet - usual)}</div><div className="label">Compared with a usual day</div></div>
              </div>
              {specials.map((s) => {
                const extra = Number(s.extra);
                const units = Number(s.units);
                return (
                  <div key={s.special_id} className="sheet">
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                      <h3>{s.name}</h3>
                      <span className="status" data-status={extra ? "variance" : "matched"}>{extra ? "Doesn’t tally" : "Tallies"}</span>
                    </div>
                    <p className="small muted" style={{ margin: "4px 0 10px" }}>
                      {s.deals} deals sold, so {s.should_units} items should have gone out. {units} did{extra ? `: ${Math.abs(extra)} ${extra > 0 ? "extra" : "short"}` : ""}.
                    </p>
                    <ul className="lines">
                      {(s.mix as any[]).map((m, i) => {
                        const left = stock.find((x) => x.product_id === m.product_id);
                        return (
                          <li key={m.product_id} className="line">
                            <span className="name">{m.name}{i === 0 ? " (most picked)" : ""}</span>
                            <span className="diff" style={{ fontSize: 20 }}>{Number(m.qty)}</span>
                            <span className="meta">{units ? Math.round((Number(m.qty) / units) * 100) : 0}% of the deal{left ? `. ${formatQty(left.counted_closing, left.base_unit)} left${left.low_next ? ", running low" : ""}` : ""}</span>
                          </li>
                        );
                      })}
                    </ul>
                    <table className="working" style={{ marginTop: 10 }}><tbody>
                      <tr><td>Taken for {s.deals} deals</td><td>{formatZar(s.taken)}</td></tr>
                      <tr><td>Same items at normal prices</td><td>{formatZar(s.at_normal_price)}</td></tr>
                      <tr><td>Discount given</td><td>{formatZar(s.discount)}</td></tr>
                      {extra > 0 && <tr><td>Extra items not paid for</td><td style={{ color: "var(--variance)" }}>{extra} ({formatZar(s.extra_value)})</td></tr>}
                      <tr className="total"><td>These items sold this shift, all prices</td><td>{units + Number(s.normal_sold_same_items)}</td></tr>
                    </tbody></table>
                  </div>
                );
              })}
              <h2>What the specials did to the shift</h2>
              <div className="sheet"><table className="working"><tbody>
                <tr><td>Total taken</td><td>{formatZar(posNet)}</td></tr>
                <tr><td>From specials</td><td>{formatZar(specialTaken)}</td></tr>
                <tr><td>From everything else</td><td>{formatZar(posNet - specialTaken)}</td></tr>
                <tr><td>Usual day without specials{usual !== null ? ` (last ${recon.usual_day.shifts} shifts)` : ""}</td><td>{!compareAllowed ? <a href="/billing">Business plan</a> : usual === null ? "Not enough history yet" : formatZar(usual)}</td></tr>
                {usual !== null && <tr className="total"><td>Compared with a usual day</td><td>{signedZar(posNet - usual)}</td></tr>}
              </tbody></table></div>
            </>
          )}
        </>
      )}

      {tab === "last" && (
        <>
          <p className="muted small">What was on the shelf when the shift started, plus deliveries and transfers in.</p>
          <ul className="lines">
            {stock.map((s) => {
              const added = Number(s.receipts) + Number(s.transfers_in);
              return (
                <li key={s.product_id} className="line">
                  <span className="name">{s.name}</span>
                  <span className="diff" style={{ fontSize: 20 }}>{formatQty(s.opening, s.base_unit)}</span>
                  {added ? <span className="meta">+ {formatQty(added, s.base_unit)} delivered or transferred in</span> : null}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {tab === "now" && (
        <>
          <p className="muted small">What {closedBy || "staff"} counted at close, next to what should be there. Should have = last shift stock + deliveries − what the till sold − wastage.</p>
          <ul className="lines">
            {stock.map((s) => {
              const v = n(s.variance);
              const st = s.went_into_minus || (v !== null && v < 0) ? "variance" : v === null ? "missing_evidence" : v > 0 ? "pending" : "matched";
              const val = missing.find((m) => m.product_id === s.product_id)?.value;
              return (
                <li key={s.product_id} className="line" data-status={st}>
                  <span className="name">{s.name}</span>
                  <span className="diff" data-status={st} style={{ fontSize: 20 }}>{v === null ? "Not counted" : v === 0 ? "Tallies" : signedQty(v, s.base_unit)}</span>
                  <span className="meta">
                    Counted {formatQty(s.counted_closing, s.base_unit)}, should have {formatQty(s.expected_closing, s.base_unit)}
                    {val ? `. Worth ${formatZar(val)}` : ""}{s.went_into_minus ? ". Went into minus" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {tab === "made" && money && (
        <>
          <p className="muted small">Money each product brought in on the till, best seller first.</p>
          <ul className="lines">
            {(recon.made as any[]).map((m) => (
              <li key={m.product_id} className="line">
                <span className="name">{m.name}</span>
                <span className="diff" style={{ fontSize: 20 }}>{formatZar(m.total_amount)}</span>
                <span className="meta">
                  {formatQty(m.normal_qty, m.base_unit)} at normal price ({formatZar(m.normal_amount)})
                  {Number(m.special_qty) ? `, ${formatQty(m.special_qty, m.base_unit)} on special (${formatZar(m.special_amount)})` : ""}
                </span>
              </li>
            ))}
          </ul>
          <h2>Does the money tally?</h2>
          <div className="sheet"><table className="working"><tbody>
            <tr><td>Opening float</td><td>{formatZar(recon.cash.opening_float)}</td></tr>
            <tr><td>+ Cash sales{recon.cash.source === "till_report" ? " (till report)" : ""}</td><td>{formatZar(recon.cash.cash_sales)}</td></tr>
            {Number(recon.cash.cash_refunds) !== 0 && <tr><td>− Cash refunds</td><td>{formatZar(recon.cash.cash_refunds)}</td></tr>}
            {Number(recon.cash.paid_out) !== 0 && <tr><td>− Paid out</td><td>{formatZar(recon.cash.paid_out)}</td></tr>}
            {Number(recon.cash.removed) + Number(recon.cash.banked) !== 0 && <tr><td>− Removed or banked</td><td>{formatZar(Number(recon.cash.removed) + Number(recon.cash.banked))}</td></tr>}
            {Number(recon.cash.paid_in) !== 0 && <tr><td>+ Paid in</td><td>{formatZar(recon.cash.paid_in)}</td></tr>}
            <tr className="total"><td>Cash that should be in the till</td><td>{formatZar(recon.cash.expected)}</td></tr>
            <tr><td>Cash counted</td><td>{formatZar(recon.cash.counted)}</td></tr>
            <tr><td>Cash difference</td><td style={{ color: `var(--${recon.cash.status === "matched" ? "matched" : "variance"})` }}>{signedZar(recon.cash.variance)}</td></tr>
            {(recon.settlements as any[]).map((x) => (
              <tr key={x.method}><td>{x.method === "card" ? "Card" : x.method.toUpperCase()}: till {formatZar(x.pos_expected)}, {x.status === "pending" ? "not checked yet" : `machine or statement ${formatZar(x.net)}`}</td>
                <td style={{ color: `var(--${x.status === "matched" ? "matched" : x.status === "pending" ? "pending" : "variance"})` }}>{x.status === "pending" ? "Pending" : signedZar(x.variance)}</td></tr>
            ))}
          </tbody></table></div>
          {missingTotal > 0 && <p className="small muted">The till and cash can match while stock still disappears, when a sale is never rung up or stock is taken. That’s why OnPoint also values the missing stock: {formatZar(missingTotal)} this shift.</p>}
          {Number(recon.sales.unmapped_lines) > 0 && <p className="notice small">{recon.sales.unmapped_lines} till line(s) didn’t match a product code. Fix the codes in Settings.</p>}
        </>
      )}

      {tab === "next" && (
        <>
          <p className="muted small">What the next shift starts with. Their opening count is checked against these numbers.</p>
          <ul className="lines">
            {stock.map((s) => (
              <li key={s.product_id} className="line" data-status={s.low_next ? "pending" : undefined}>
                <span className="name">{s.name}</span>
                <span className="diff" data-status={s.low_next ? "pending" : undefined} style={{ fontSize: 20 }}>{formatQty(s.counted_closing, s.base_unit)}</span>
                {s.low_next ? <span className="meta">Running low. Warn level {formatQty(s.low_stock_level, s.base_unit)}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
