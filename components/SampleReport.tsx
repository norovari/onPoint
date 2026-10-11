// A sample monthly report with made-up numbers, laid out exactly like the real
// one (app/reports/monthly). Shown in the demo and to shops with no shifts yet.

const zar = (n: number) => `R${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;

const MISSING = [
  { name: "Indoor AAA flower", qty: "14g", shifts: 6, value: 1680 },
  { name: "Indoor A flower", qty: "12.5g", shifts: 5, value: 1000 },
  { name: "Indoor pre-roll: OG Kush", qty: "6", shifts: 4, value: 600 },
  { name: "Greenhouse flower", qty: "9g", shifts: 3, value: 450 },
  { name: "Gummies 10 pack", qty: "2", shifts: 2, value: 260 },
];
const PEOPLE = [
  { who: "Sipho", shifts: 15, alerts: 9, missing: 2310 },
  { who: "Lerato", shifts: 14, alerts: 3, missing: 720 },
  { who: "Johan", shifts: 13, alerts: 4, missing: 580 },
  { who: "Thandi", shifts: 16, alerts: 2, missing: 380 },
];
const SHIFTS = PEOPLE.reduce((a, p) => a + p.shifts, 0);
const MISSING_TOTAL = MISSING.reduce((a, p) => a + p.value, 0);
const CASH_SHORT = 1240;
const SPECIALS_EXTRA = 14;

export function SampleReport({ businessName, note }: { businessName: string; note?: string }) {
  return (
    <div>
      <p className="notice">
        <strong>Sample report.</strong> {note ?? `This is what ${businessName} would see after a month on OnPoint. The numbers are made up.`}
      </p>
      <p className="lede">The last 30 days at {businessName}. Differences are things to look into, not proof of wrongdoing.</p>
      <div className="figures">
        <div className="figure"><div className="value">{SHIFTS}</div><div className="label">Shifts closed</div></div>
        <div className="figure"><div className="value" style={{ color: "var(--variance)" }}>{zar(MISSING_TOTAL)}</div><div className="label">Missing stock value</div></div>
        <div className="figure"><div className="value" style={{ color: "var(--variance)" }}>{zar(CASH_SHORT)}</div><div className="label">Cash short</div></div>
        <div className="figure"><div className="value">{SPECIALS_EXTRA}</div><div className="label">Extra items out on specials</div></div>
      </div>

      <h2>What goes missing most</h2>
      <ul className="lines">
        {MISSING.map((p) => (
          <li key={p.name} className="line" data-status="variance">
            <span className="name">{p.name}</span>
            <span className="diff" data-status="variance" style={{ fontSize: 20 }}>{zar(p.value)}</span>
            <span className="meta">{p.qty} missing over {p.shifts} shifts</span>
          </li>
        ))}
      </ul>

      <h2>By person closing the shift</h2>
      <div className="scroll">
        <table className="data">
          <thead><tr><th>Person</th><th className="num">Shifts</th><th className="num">Alerts</th><th className="num">Missing stock</th></tr></thead>
          <tbody>
            {PEOPLE.map((p) => (
              <tr key={p.who}><td>{p.who}</td><td className="num">{p.shifts}</td><td className="num">{p.alerts}</td><td className="num">{zar(p.missing)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Missing stock is valued at today’s selling prices. In this sample, more than half of what went missing was on one person’s shifts. That’s the kind of pattern the report makes easy to spot.</p>
    </div>
  );
}
