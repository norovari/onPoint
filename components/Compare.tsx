// How OnPoint compares with a standard POS and with a POS plus an AI
// reporting tool. Plain words, short cells, readable on a phone.
// Keep every OnPoint claim true to what is live in the app.

type Cell = { v: "yes" | "no" | "some"; t: string };
const Y = (t: string): Cell => ({ v: "yes", t });
const N = (t: string): Cell => ({ v: "no", t });
const S = (t: string): Cell => ({ v: "some", t });

const ROWS: { what: string; means: string; pos: Cell; ai: Cell; op: Cell }[] = [
  { what: "Records every sale", means: "Rings up each product, price and payment.", pos: Y("Its main job"), ai: Y("Via the POS"), op: N("Reads the till’s sales") },
  { what: "Cash counted at close", means: "Expected cash against what’s in the drawer.", pos: Y("Usually"), ai: Y("Via the POS"), op: Y("Plus the card total") },
  { what: "Reports across outlets", means: "One view of several shops.", pos: Y("Usually"), ai: Y("A key strength"), op: Y("Multi-site plan") },
  { what: "Stock checked at every handover", means: "Stock, not just cash, is checked when one shift hands over to the next.", pos: N("Cash only"), ai: S("If someone types counts in"), op: Y("Built into closing") },
  { what: "Stock and cash in one answer", means: "“Everything tallied”, or exactly which product or amount to check.", pos: N("Separate reports"), ai: S("If prompted"), op: Y("Every shift") },
  { what: "Spot-checks, not full counts", means: "A short list each night: some random, some that didn’t tally, some overdue.", pos: N("You choose"), ai: N("No"), op: Y("About 12 a night") },
  { what: "Count split between staff", means: "Everyone on shift gets different products to check.", pos: N("No"), ai: N("No"), op: Y("At random") },
  { what: "Blind counts", means: "Staff don’t see the expected figure, so they can’t just copy it.", pos: S("Cash only, if set"), ai: S("Depends"), op: Y("Stock and cash") },
  { what: "Jar weighing and bag allowance", means: "Empty jar taken off; a 2.2 g “2 g bag” isn’t flagged, over-filling is.", pos: N("No"), ai: N("No"), op: Y("Per product") },
  { what: "Staff confirmation", means: "Three questions, photos and each person’s own password at close.", pos: N("No"), ai: N("No"), op: Y("Every close") },
  { what: "Differences must be explained", means: "Stays open until someone gives a reason and a manager signs off.", pos: N("No"), ai: S("Flags only"), op: Y("Yes") },
  { what: "Supplier orders", means: "Purchase orders to suppliers.", pos: S("Often an add-on"), ai: S("Depends"), op: N("Keep your POS for this") },
];

const MARK = { yes: "✓", no: "✗", some: "~" } as const;

export function Compare() {
  return (
    <section aria-labelledby="cmp-h" className="compare">
      <h2 id="cmp-h">How OnPoint compares</h2>
      <p className="small" style={{ marginTop: -4 }}>
        Your till <strong>records</strong> sales. An AI report <strong>reads and flags</strong> them. OnPoint <strong>checks the shift and follows up</strong>. It works alongside your POS, not instead of it.
      </p>
      <div className="scroll">
        <table className="data cmp">
          <thead>
            <tr><th scope="col">What happens</th><th scope="col">Standard POS</th><th scope="col">POS + AI reports</th><th scope="col">OnPoint</th></tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.what}>
                <th scope="row"><span className="cmp-what">{r.what}</span><span className="cmp-means">{r.means}</span></th>
                {[r.pos, r.ai, r.op].map((c, i) => (
                  <td key={i} data-v={c.v} data-label={["Standard POS", "POS + AI reports", "OnPoint"][i]} className={i === 2 ? "cmp-op" : undefined}>
                    <span className="cmp-mark" aria-hidden="true">{MARK[c.v]}</span> {c.t}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">✓ yes · ~ partly, or only if someone sets it up and keeps it running · ✗ no</p>
    </section>
  );
}
