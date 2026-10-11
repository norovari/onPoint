import { analyse, DAY, qtyText, zar, type Insights } from "@/lib/insights";

// The monthly report: what sells and when, stock to watch, what didn't tally,
// and what to do about it. Same layout for real figures and the sample.

const pct = (x: number) => `${Math.round(x * 100)}%`;
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

function Bar({ value, max, tone = "ink" }: { value: number; max: number; tone?: string }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span aria-hidden style={{ display: "block", height: 8, borderRadius: 4, background: "var(--line, #ddd)", marginTop: 6 }}>
      <span style={{ display: "block", height: 8, width: `${w}%`, borderRadius: 4, background: `var(--${tone})` }} />
    </span>
  );
}

export function InsightsReport({ data, businessName }: { data: Insights; businessName: string }) {
  const a = analyse(data);
  const maxDay = Math.max(...data.by_dow.map((d) => d.sales), 0);
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first

  return (
    <div>
      <p className="lede">The last {data.days} days at {businessName}.</p>
      <div className="figures">
        <div className="figure"><div className="value">{zar(data.sales_total)}</div><div className="label">Sales{a.salesChangePct !== null ? `, ${a.salesChangePct >= 0 ? "up" : "down"} ${Math.abs(a.salesChangePct)}% on the month before` : ""}</div></div>
        <div className="figure"><div className="value">{data.shifts_closed}</div><div className="label">Shifts closed</div></div>
        <div className="figure"><div className="value">{zar(a.perShift)}</div><div className="label">Average sales per shift</div></div>
        <div className="figure"><div className="value">{pct(data.card_share)}</div><div className="label">Paid by card</div></div>
      </div>

      {a.recommendations.length > 0 && (
        <>
          <h2>What to do this month</h2>
          <ol className="lines" style={{ paddingLeft: 0, listStyle: "none" }}>
            {a.recommendations.map((r, i) => (
              <li key={i} className="line">
                <span className="meta" style={{ textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 700 }}>{r.area}</span>
                <span className="name" style={{ fontWeight: 400 }}>{r.text}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      <h2>What your customers buy</h2>
      <ul className="lines">
        {a.best.map((p) => (
          <li key={p.name} className="line">
            <span className="name">{p.name}</span>
            <span className="diff" style={{ fontSize: 18 }}>{zar(p.sales)}</span>
            <span className="meta">{qtyText(p.qty, p.unit)} sold, {pct(p.share)} of sales</span>
          </li>
        ))}
      </ul>
      {(a.rising.length > 0 || a.falling.length > 0) && (
        <p className="small">
          {a.rising.length > 0 && <>Growing: {a.rising.map((p) => `${p.name} (+${p.change}%)`).join(", ")}. </>}
          {a.falling.length > 0 && <>Slowing down: {a.falling.map((p) => `${p.name} (${p.change}%)`).join(", ")}.</>}
        </p>
      )}

      <h2>When they buy</h2>
      <div className="sheet">
        {order.map((dow) => {
          const d = data.by_dow.find((x) => x.dow === dow);
          return (
            <div key={dow} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }} className="small"><span>{DAY[dow]}</span><span>{zar(d?.sales ?? 0)}</span></div>
              <Bar value={d?.sales ?? 0} max={maxDay} />
            </div>
          );
        })}
        {a.peak && <p className="small muted" style={{ marginBottom: 0 }}>Busiest time of day: {hh(a.peak.from)} to {hh(a.peak.to)}, {pct(a.peak.share)} of sales.</p>}
      </div>

      {data.specials.length > 0 && (
        <>
          <h2>Specials</h2>
          <ul className="lines">
            {data.specials.map((s) => (
              <li key={s.name} className="line">
                <span className="name">{s.name}</span>
                <span className="diff" style={{ fontSize: 18 }}>{zar(s.revenue)}</span>
                <span className="meta">{s.deals} deals sold</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {(a.runningLow.length > 0 || a.slow.length > 0) && (
        <>
          <h2>Stock to watch</h2>
          <ul className="lines">
            {a.runningLow.map((p) => (
              <li key={`low-${p.name}`} className="line" data-status="pending">
                <span className="name">{p.name}</span>
                <span className="meta">{p.out_shifts > 0 ? `Ran out on ${p.out_shifts} shift${p.out_shifts === 1 ? "" : "s"}, low on ${p.low_shifts}` : `Low on ${p.low_shifts} shifts`}. Order more.</span>
              </li>
            ))}
            {a.slow.map((p) => (
              <li key={`slow-${p.name}`} className="line">
                <span className="name">{p.name}</span>
                <span className="meta">{qtyText(p.on_hand ?? 0, p.unit)} on hand, about {Number.isFinite(p.cover) ? `${Math.round(p.cover)} days` : "months"} of stock at the current pace. Order less.</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Stock and cash that didn’t tally</h2>
      {a.differences.length === 0 && data.cash_short_shifts === 0 ? (
        <p className="notice ok">Everything tallied this month.</p>
      ) : (
        <>
          <p className="small muted">These are things to look into, not proof of wrongdoing. Most come from weighing, deals not being recorded, or stock moved without a note.</p>
          <ul className="lines">
            {a.differences.map((p) => (
              <li key={p.name} className="line" data-status="variance">
                <span className="name">{p.name}</span>
                <span className="diff" data-status="variance" style={{ fontSize: 18 }}>{zar(p.diff_value)}</span>
                <span className="meta">{qtyText(p.diff_qty, p.unit)} over {p.diff_shifts} shift{p.diff_shifts === 1 ? "" : "s"}</span>
              </li>
            ))}
            {data.cash_short_shifts > 0 && (
              <li className="line" data-status="variance">
                <span className="name">Cash</span>
                <span className="diff" data-status="variance" style={{ fontSize: 18 }}>{zar(data.cash_short_total)}</span>
                <span className="meta">Short on {data.cash_short_shifts} shift{data.cash_short_shifts === 1 ? "" : "s"}</span>
              </li>
            )}
          </ul>
          {a.diffDays.length > 0 && (
            <p className="small">Most stock differences were on {a.diffDays.map((d) => `${DAY[d.dow]} (${pct(d.share)})`).join(" and ")}.</p>
          )}
        </>
      )}
      <p className="muted small">Missing stock is valued at today’s selling prices.</p>
    </div>
  );
}
