// Shows the reconciliation with its working, so every figure can be traced.
import { formatQty, formatZar } from "@/lib/calculations";
import { RECON_STATUS } from "@/lib/labels";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Recon = any;

const signedQty = (v: unknown, unit: string) => {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatQty(Math.abs(n), unit)}`;
};
const signedZar = (v: unknown) => {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return n > 0 ? `+${formatZar(n)}` : formatZar(n);
};

export function ReconView({ recon }: { recon: Recon }) {
  const stock = recon.stock as any[];
  const varied = stock.filter((s) => s.status !== "matched").length;

  return (
    <>
      {recon.money_visible && (
        <div className="figures">
          <Figure label="Sold on the till" value={formatZar(recon.sales.pos_net)} />
          <Figure label="Cash difference" value={signedZar(recon.cash.variance)} status={recon.cash.status} />
          <Figure label="Stock differences to review" value={String(varied)} status={varied ? "variance" : "matched"} />
          <Figure
            label="Waiting for the bank"
            value={String((recon.settlements as any[]).filter((x) => x.status === "pending").length)}
            status={(recon.settlements as any[]).some((x) => x.status === "pending") ? "pending" : "matched"}
          />
        </div>
      )}

      <h2>Stock</h2>
      <p className="muted small">Expected = opening + deliveries + transfers in ± adjustments − sold − transfers out − wastage − damage − internal use.</p>
      <ul className="lines">
        {stock.map((s) => (
          <li key={s.product_id} className="line" data-status={s.status}>
            <span className="name">{s.name}</span>
            <span className="diff" data-status={s.status}>
              {s.status === "missing_evidence" || s.status === "not_counted" ? "Not counted" : signedQty(s.variance, s.base_unit)}
            </span>
            <span className="meta">
              {s.status === "not_counted" ? `Not checked tonight. Carried over at ${formatQty(s.expected_closing, s.base_unit)}` : `Expected ${formatQty(s.expected_closing, s.base_unit)}, counted ${formatQty(s.counted_closing, s.base_unit)}`}
              <details>
                <summary className="small">Show working</summary>
                <table className="working">
                  <tbody>
                    <tr><td>Opening stock</td><td>{formatQty(s.opening, s.base_unit)}</td></tr>
                    {Number(s.receipts) !== 0 && <tr><td>+ Deliveries</td><td>{formatQty(s.receipts, s.base_unit)}</td></tr>}
                    {Number(s.transfers_in) !== 0 && <tr><td>+ Stock moved in</td><td>{formatQty(s.transfers_in, s.base_unit)}</td></tr>}
                    {Number(s.adjustments) !== 0 && <tr><td>± Other changes</td><td>{signedQty(s.adjustments, s.base_unit)}</td></tr>}
                    <tr><td>− Sold on the till</td><td>{formatQty(s.net_sold, s.base_unit)}</td></tr>
                    {Number(s.transfers_out) !== 0 && <tr><td>− Stock moved out</td><td>{formatQty(s.transfers_out, s.base_unit)}</td></tr>}
                    {Number(s.wastage) !== 0 && <tr><td>− Spills and thrown away</td><td>{formatQty(s.wastage, s.base_unit)}</td></tr>}
                    {Number(s.damage) !== 0 && <tr><td>− Damaged</td><td>{formatQty(s.damage, s.base_unit)}</td></tr>}
                    {Number(s.internal_use) !== 0 && <tr><td>− Staff use</td><td>{formatQty(s.internal_use, s.base_unit)}</td></tr>}
                    <tr className="total"><td>Expected closing stock</td><td>{formatQty(s.expected_closing, s.base_unit)}</td></tr>
                  </tbody>
                </table>
                {Number(s.unapproved_movements) > 0 && (
                  <p className="notice small">{s.unapproved_movements} stock change(s) here are waiting for approval.</p>
                )}
              </details>
            </span>
          </li>
        ))}
      </ul>

      {!recon.money_visible && (
        <p className="muted small">Cash and sales figures are visible to managers and to the people who worked this shift.</p>
      )}

      {recon.money_visible && (
        <>
          <h2>Cash in the till</h2>
          <div className="sheet">
            <table className="working">
              <tbody>
                <tr><td>Starting float</td><td>{formatZar(recon.cash.opening_float)}</td></tr>
                <tr><td>+ Cash sales</td><td>{formatZar(recon.cash.cash_sales)}</td></tr>
                <tr><td>− Cash refunds</td><td>{formatZar(recon.cash.cash_refunds)}</td></tr>
                {Number(recon.cash.paid_in) !== 0 && <tr><td>+ Cash added</td><td>{formatZar(recon.cash.paid_in)}</td></tr>}
                {Number(recon.cash.paid_out) !== 0 && <tr><td>− Cash paid out</td><td>{formatZar(recon.cash.paid_out)}</td></tr>}
                {Number(recon.cash.removed) !== 0 && <tr><td>− Cash moved to the safe</td><td>{formatZar(recon.cash.removed)}</td></tr>}
                {Number(recon.cash.banked) !== 0 && <tr><td>− Banked</td><td>{formatZar(recon.cash.banked)}</td></tr>}
                <tr className="total"><td>Expected cash</td><td>{formatZar(recon.cash.expected)}</td></tr>
                <tr><td>Counted</td><td>{formatZar(recon.cash.counted)}</td></tr>
                <tr><td>Difference</td><td style={{ color: `var(--${recon.cash.status === "matched" ? "matched" : recon.cash.status === "variance" ? "variance" : "pending"})` }}>{signedZar(recon.cash.variance)}</td></tr>
              </tbody>
            </table>
          </div>

          <h2>Card payouts from the bank</h2>
          {(recon.settlements as any[]).length === 0 ? (
            <p className="muted">No card or EFT sales in this shift.</p>
          ) : (
            <ul className="lines">
              {(recon.settlements as any[]).map((x) => (
                <li key={x.method} className="line" data-status={x.status}>
                  <span className="name">{x.method.toUpperCase()}</span>
                  <span className="status" data-status={x.status}>{RECON_STATUS[x.status]}</span>
                  <span className="meta">
                    POS {formatZar(x.pos_expected)}
                    {x.status !== "pending" && (
                      <>, fees {formatZar(x.fees)}, expected net {formatZar(x.expected_net)}, settled {formatZar(x.net)}, difference {signedZar(x.variance)}</>
                    )}
                    {x.status === "pending" && <>. The bank hasn’t paid this amount yet. This isn’t treated as a loss.</>}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h2>Sales cross-check</h2>
          <div className="sheet">
            <table className="working">
              <tbody>
                <tr><td>Till sales before discounts</td><td>{formatZar(recon.sales.pos_gross)}</td></tr>
                <tr><td>Discounts</td><td>{formatZar(recon.sales.pos_discounts)}</td></tr>
                <tr><td>Refunds</td><td>{formatZar(recon.sales.pos_refunds)}</td></tr>
                <tr className="total"><td>POS net sales</td><td>{formatZar(recon.sales.pos_net)}</td></tr>
                <tr><td>Quantities × list prices</td><td>{formatZar(recon.sales.calculated_at_list)}</td></tr>
                <tr><td>Till sales for the same items</td><td>{formatZar(recon.sales.pos_gross_mapped)}</td></tr>
                <tr><td>Price difference</td><td>{signedZar(recon.sales.sales_value_variance)}</td></tr>
              </tbody>
            </table>
            {(Number(recon.sales.unmapped_lines) > 0 || Number(recon.sales.unpriced_lines) > 0) && (
              <p className="notice small">
                {recon.sales.unmapped_lines} POS line(s) didn’t match a product code and {recon.sales.unpriced_lines} had no price set. Fix the product codes in Settings.
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Figure({ label, value, status }: { label: string; value: string; status?: string }) {
  const color = status === "matched" ? "var(--matched)" : status === "variance" ? "var(--variance)" : status ? "var(--pending)" : undefined;
  return (
    <div className="figure">
      <div className="value" style={{ color }}>{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}
