import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession, isManager } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { PosImport } from "@/components/PosImport";
import { ReconView, type Recon } from "@/components/ReconView";
import {
  activateShift,
  approveMovement,
  recordCashEvent,
  recordMovement,
  recordSettlement,
  reviewShift,
  saveCounts,
  submitClosing,
} from "@/app/actions";
import { formatQty, formatZar } from "@/lib/calculations";
import { CASH_EVENT, MOVEMENT_TYPE, SHIFT_STATUS, when } from "@/lib/labels";

export const metadata = { title: "Shift" };

type Product = { id: string; sku: string; name: string; base_unit: string; tracking_mode: string };
type Count = { product_id: string; count_type: string; quantity: string; version: number };

const STAGES = ["opening", "active", "closing_submitted", "approved"];

export default async function ShiftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await requireSession();
  const { supabase } = s;
  const manager = isManager(s.role);

  const { data: shift } = await supabase
    .from("shifts")
    .select("*, locations(name), opener:profiles!shifts_opened_by_fkey(full_name), closer:profiles!shifts_closed_by_fkey(full_name)")
    .eq("id", id)
    .maybeSingle();
  if (!shift) notFound();

  const [{ data: products }, { data: counts }, { data: movements }, { data: cashEvents }, { data: imports }, { data: approvals }, { data: settlementsRows }] =
    await Promise.all([
      supabase.from("products").select("id, sku, name, base_unit, tracking_mode").eq("active", true).order("sku"),
      supabase.from("stock_counts").select("product_id, count_type, quantity, version").eq("shift_id", id),
      supabase
        .from("stock_movements")
        .select("id, product_id, movement_type, quantity, reason, reference, requires_approval, approved_by, created_by, created_at, products(name, base_unit)")
        .eq("shift_id", id)
        .order("created_at"),
      supabase.from("cash_events").select("id, event_type, amount, reason, created_at").eq("shift_id", id).order("created_at"),
      supabase.from("pos_imports").select("id, file_name, row_count, pos_total_sales, imported_at").eq("shift_id", id).order("imported_at"),
      supabase.from("approvals").select("decision, notes, decided_at, profiles(full_name)").eq("shift_id", id).order("decided_at", { ascending: false }),
      supabase.from("settlement_records").select("id, payment_method, provider, provider_reference, net_amount").eq("shift_id", id),
    ]);

  const status = shift.status as string;
  const st = SHIFT_STATUS[status];
  const stageIdx = STAGES.indexOf(status === "correction_requested" ? "active" : status);
  const latest = (type: string) => {
    const m = new Map<string, Count>();
    for (const c of (counts ?? []) as Count[]) {
      if (c.count_type !== type) continue;
      const cur = m.get(c.product_id);
      if (!cur || cur.version < c.version) m.set(c.product_id, c);
    }
    return m;
  };
  const opening = latest("opening");
  const closing = latest("closing");
  const workedIt = [shift.opened_by, shift.closed_by].includes(s.userId);
  const canEnter = ["opening", "active", "correction_requested"].includes(status);
  const showRecon = ["closing_submitted", "correction_requested", "approved"].includes(status);

  let recon: Recon | null = null;
  if (showRecon) {
    const { data } = await supabase.rpc("shift_reconciliation", { p_shift: id });
    recon = data;
  }

  const loc = (shift.locations as unknown as { name: string } | null)?.name;
  const opener = (shift.opener as unknown as { full_name: string } | null)?.full_name;
  const closer = (shift.closer as unknown as { full_name: string } | null)?.full_name;
  const lastReturn = (approvals ?? []).find((a) => a.decision === "returned");
  const pendingMovements = (movements ?? []).filter((m) => m.requires_approval && !m.approved_by);

  return (
    <Shell businessName={s.businessName}>
      <ol className="steps" aria-label="Shift progress">
        {STAGES.map((x, i) => (
          <li key={x} data-done={i < stageIdx || status === "approved"} data-current={i === stageIdx && status !== "approved"} />
        ))}
      </ol>
      <span className="status" data-status={st.tone}>{st.label}</span>
      <h1>{loc}</h1>
      <p className="lede">
        Opened {when(shift.opened_at)}{opener ? ` by ${opener}` : ""}
        {shift.closing_submitted_at ? `. Closed ${when(shift.closing_submitted_at)}${closer ? ` by ${closer}` : ""}.` : "."}
      </p>

      {status === "correction_requested" && lastReturn && (
        <div className="notice error">
          <strong>Returned by {(lastReturn.profiles as unknown as { full_name: string } | null)?.full_name || "a manager"}:</strong> {lastReturn.notes}
          <br />
          Recount what’s needed below (each recount needs a reason), then submit the close again.
        </div>
      )}

      {/* ---------------- Opening ---------------- */}
      {status === "opening" && (
        <>
          <h2>Count opening stock</h2>
          <p className="muted">
            Count what is physically on the shelf. Weighed items are in grams. You can save as you go and come back.
          </p>
          <CountSheet shiftId={id} type="opening" products={products ?? []} counts={opening} />
          <ActionForm action={activateShift} hidden={{ shift_id: id }}>
            <div className="actionbar">
              <div>
                <span className="small muted">{opening.size} of {products?.length ?? 0} counted</span>
                <Submit>Finish opening</Submit>
              </div>
            </div>
          </ActionForm>
        </>
      )}

      {/* ---------------- During the shift ---------------- */}
      {(status === "active" || status === "correction_requested") && (
        <>
          <h2>Stock movements</h2>
          <p className="muted small">
            Record anything that changes stock other than a sale: deliveries, transfers, wastage. Sales come from the POS export.
          </p>
          <ActionForm action={recordMovement} hidden={{ shift_id: id }} className="sheet">
            <div className="row">
              <div>
                <label htmlFor="mv-type">What happened</label>
                <select id="mv-type" name="movement_type" defaultValue="RECEIPT">
                  {Object.entries(MOVEMENT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="mv-product">Product</label>
                <select id="mv-product" name="product_id">
                  {(products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
            <div className="row">
              <div>
                <label htmlFor="mv-qty">Quantity <span className="hint">units or grams</span></label>
                <input id="mv-qty" name="quantity" inputMode="decimal" required />
              </div>
              <div>
                <label htmlFor="mv-ref">Reference <span className="hint">optional</span></label>
                <input id="mv-ref" name="reference" placeholder="Delivery note no." />
              </div>
            </div>
            <label htmlFor="mv-reason">Reason</label>
            <input id="mv-reason" name="reason" required />
            {!manager && <p className="muted small">Wastage, damage, internal use, transfers out and adjustments need a manager to approve them.</p>}
            <div style={{ marginTop: 12 }}><Submit>Record movement</Submit></div>
          </ActionForm>

          {manager && (
            <>
              <h2>POS sales</h2>
              <div className="sheet">
                <PosImport shiftId={id} />
                {(imports ?? []).length > 0 && (
                  <p className="muted small" style={{ marginBottom: 0 }}>
                    Imported: {(imports ?? []).map((i) => `${i.file_name} (${i.row_count} lines, ${formatZar(i.pos_total_sales)})`).join("; ")}
                  </p>
                )}
              </div>

              <h2>Cash taken out or put in</h2>
              <ActionForm action={recordCashEvent} hidden={{ shift_id: id }} className="sheet">
                <div className="row">
                  <div>
                    <label htmlFor="ce-type">Type</label>
                    <select id="ce-type" name="event_type" defaultValue="REMOVED">
                      {Object.entries(CASH_EVENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="ce-amount">Amount (R)</label>
                    <input id="ce-amount" name="amount" type="number" inputMode="decimal" step="0.01" min="0.01" required />
                  </div>
                </div>
                <label htmlFor="ce-reason">Reason</label>
                <input id="ce-reason" name="reason" required placeholder="e.g. Drop to safe at 14:00" />
                <div style={{ marginTop: 12 }}><Submit>Record cash movement</Submit></div>
                {(cashEvents ?? []).length > 0 && (
                  <p className="muted small">
                    Recorded: {(cashEvents ?? []).map((e) => `${CASH_EVENT[e.event_type]} ${formatZar(e.amount)}`).join("; ")}
                  </p>
                )}
              </ActionForm>

              <h2>Card and EFT settlement</h2>
              <p className="muted small">
                Enter figures from the bank or card-machine statement. If it hasn’t arrived yet, leave this. It will show as awaiting settlement, not as a loss.
              </p>
              <ActionForm action={recordSettlement} hidden={{ shift_id: id }} className="sheet">
                <div className="row">
                  <div>
                    <label htmlFor="st-method">Method</label>
                    <select id="st-method" name="payment_method"><option value="card">Card</option><option value="eft">EFT</option><option value="other">Other</option></select>
                  </div>
                  <div>
                    <label htmlFor="st-date">Settlement date</label>
                    <input id="st-date" name="settlement_date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
                  </div>
                </div>
                <div className="row">
                  <div><label htmlFor="st-provider">Provider</label><input id="st-provider" name="provider" required placeholder="Bank or acquirer" /></div>
                  <div><label htmlFor="st-ref">Statement reference</label><input id="st-ref" name="reference" required /></div>
                </div>
                <div className="row">
                  <div><label htmlFor="st-gross">Gross (R)</label><input id="st-gross" name="gross" type="number" step="0.01" inputMode="decimal" required /></div>
                  <div><label htmlFor="st-fees">Fees (R)</label><input id="st-fees" name="fees" type="number" step="0.01" inputMode="decimal" defaultValue="0" /></div>
                </div>
                <div className="row">
                  <div><label htmlFor="st-refunds">Refunds (R)</label><input id="st-refunds" name="refunds" type="number" step="0.01" inputMode="decimal" defaultValue="0" /></div>
                  <div><label htmlFor="st-adj">Adjustments (R, ±)</label><input id="st-adj" name="adjustments" inputMode="decimal" defaultValue="0" /></div>
                </div>
                <div style={{ marginTop: 12 }}><Submit>Record settlement</Submit></div>
                {(settlementsRows ?? []).length > 0 && (
                  <p className="muted small">
                    Recorded: {(settlementsRows ?? []).map((r) => `${r.payment_method.toUpperCase()} ${r.provider} ${r.provider_reference} net ${formatZar(r.net_amount)}`).join("; ")}
                  </p>
                )}
              </ActionForm>
            </>
          )}

          <h2>{status === "correction_requested" ? "Recount" : "Close the shift"}</h2>
          <p className="muted">
            Count closing stock without looking at the system figures. The differences are worked out after you submit.
          </p>
          <CountSheet shiftId={id} type="closing" products={products ?? []} counts={closing} needsReason={status === "correction_requested"} />

          <ActionForm action={submitClosing} hidden={{ shift_id: id }} className="sheet">
            <label htmlFor="counted_cash">Cash counted in the till (R)</label>
            <input id="counted_cash" name="counted_cash" type="number" inputMode="decimal" step="0.01" min="0" required
              defaultValue={shift.counted_closing_cash ?? undefined} />
            <fieldset style={{ border: 0, padding: 0, margin: "12px 0 0" }}>
              <legend style={{ fontWeight: 700, fontSize: 15 }}>Handover checklist</legend>
              {[
                ["till_closed", "Till closed and drawer locked"],
                ["fridges_ok", "Fridges and equipment checked"],
                ["keys_returned", "Keys returned"],
                ["deliveries_filed", "Delivery notes filed"],
              ].map(([k, v]) => (
                <label key={k} style={{ display: "flex", gap: 10, alignItems: "center", fontWeight: 400 }}>
                  <input type="checkbox" name={k} style={{ width: "auto" }} /> {v}
                </label>
              ))}
            </fieldset>
            <label htmlFor="notes">Notes for the next shift <span className="hint">optional</span></label>
            <textarea id="notes" name="notes" rows={3} placeholder="Anything the manager or next shift should know" />
            <div className="actionbar">
              <div>
                <span className="small muted">{closing.size} of {products?.length ?? 0} counted</span>
                <Submit>Submit close for review</Submit>
              </div>
            </div>
          </ActionForm>
        </>
      )}

      {/* ---------------- Review / approved ---------------- */}
      {showRecon && recon && status !== "correction_requested" && <ReconView recon={recon} />}

      {status === "closing_submitted" && manager && (
        <>
          {pendingMovements.length > 0 && (
            <>
              <h2>Movements to approve</h2>
              <ul className="lines">
                {pendingMovements.map((m) => {
                  const p = m.products as unknown as { name: string; base_unit: string };
                  return (
                    <li key={m.id} className="line" data-status="pending">
                      <span className="name">{MOVEMENT_TYPE[m.movement_type]}: {p?.name}, {formatQty(m.quantity, p?.base_unit ?? "unit")}</span>
                      {m.created_by === s.userId ? (
                        <span className="small muted">Needs another manager</span>
                      ) : (
                        <ActionForm action={approveMovement} hidden={{ movement_id: m.id, shift_id: id }}>
                          <Submit className="quiet">Approve</Submit>
                        </ActionForm>
                      )}
                      <span className="meta">{m.reason}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <h2>Your review</h2>
          {workedIt ? (
            <p className="notice">You worked this shift, so another manager or the owner needs to review it.</p>
          ) : (
            <ActionForm action={reviewShift} hidden={{ shift_id: id }} className="sheet">
              <label htmlFor="review-notes">Notes <span className="hint">required when returning</span></label>
              <textarea id="review-notes" name="notes" rows={3} />
              <div className="row" style={{ marginTop: 12 }}>
                <Submit className="quiet" name="decision" value="returned">Return for correction</Submit>
                <Submit name="decision" value="approved">Approve shift</Submit>
              </div>
            </ActionForm>
          )}
        </>
      )}

      {status === "closing_submitted" && !manager && (
        <p className="notice ok">Submitted. A manager will review the differences.</p>
      )}

      {showRecon && (
        <p className="noprint">
          <Link href={`/reports/${id}`} className="button quiet">Open shift report</Link>
        </p>
      )}

      {/* Movements log (always visible for transparency) */}
      {(movements ?? []).length > 0 && (
        <details style={{ marginTop: 24 }}>
          <summary>Movement log ({movements!.length})</summary>
          <table className="data">
            <thead><tr><th>When</th><th>What</th><th className="num">Qty</th><th>Reason</th></tr></thead>
            <tbody>
              {movements!.map((m) => {
                const p = m.products as unknown as { name: string; base_unit: string };
                return (
                  <tr key={m.id}>
                    <td>{when(m.created_at)}</td>
                    <td>{MOVEMENT_TYPE[m.movement_type]}: {p?.name}{m.requires_approval && !m.approved_by ? " (awaiting approval)" : ""}</td>
                    <td className="num">{formatQty(m.quantity, p?.base_unit ?? "unit")}</td>
                    <td>{m.reason}{m.reference ? ` (${m.reference})` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
      {canEnter && <div style={{ height: 40 }} />}
    </Shell>
  );
}

function CountSheet({
  shiftId,
  type,
  products,
  counts,
  needsReason,
}: {
  shiftId: string;
  type: "opening" | "closing";
  products: Product[];
  counts: Map<string, Count>;
  needsReason?: boolean;
}) {
  const anySubmitted = counts.size > 0;
  return (
    <ActionForm action={saveCounts} hidden={{ shift_id: shiftId, count_type: type }}>
      <ul className="lines">
        {products.map((p) => {
          const c = counts.get(p.id);
          return (
            <li key={p.id} className="line" data-status={c ? "matched" : undefined}>
              <label htmlFor={`q-${type}-${p.id}`} style={{ margin: 0 }}>
                <span className="name">{p.name}</span>
                <span className="hint" style={{ display: "block" }}>
                  {p.sku}, {p.base_unit === "g" ? "grams" : "units"}{c && c.version > 1 ? `, recount ${c.version}` : ""}
                </span>
              </label>
              <input
                id={`q-${type}-${p.id}`}
                name={`qty:${p.id}`}
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                defaultValue={c ? String(c.quantity) : ""}
                aria-label={`${p.name} count in ${p.base_unit === "g" ? "grams" : "units"}`}
              />
            </li>
          );
        })}
      </ul>
      {(needsReason || anySubmitted) && (
        <>
          <label htmlFor={`reason-${type}`}>
            Reason for any recount <span className="hint">needed only if you change a saved count</span>
          </label>
          <input id={`reason-${type}`} name="reason" />
        </>
      )}
      <div style={{ marginTop: 12 }}>
        <Submit className="quiet">Save counts</Submit>
      </div>
    </ActionForm>
  );
}
