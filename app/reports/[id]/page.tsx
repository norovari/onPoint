import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/supabase/server";
import { ReconView } from "@/components/ReconView";
import { PrintButton } from "@/components/PrintButton";
import { EXCEPTION_TYPE, when } from "@/lib/labels";

export const metadata = { title: "Shift report" };

export default async function Report({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await requireSession();
  const { supabase } = s;
  const { data: shift } = await supabase
    .from("shifts")
    .select("*, locations(name), opener:profiles!shifts_opened_by_fkey(full_name), closer:profiles!shifts_closed_by_fkey(full_name)")
    .eq("id", id)
    .maybeSingle();
  if (!shift || shift.status === "opening" || shift.status === "active") notFound();

  const [{ data: recon }, { data: approvals }, { data: imports }, { data: handover }, { data: exceptions }] = await Promise.all([
    supabase.rpc("shift_reconciliation", { p_shift: id }),
    supabase.from("approvals").select("decision, notes, decided_at, profiles(full_name)").eq("shift_id", id).order("decided_at"),
    supabase.from("pos_imports").select("file_name, file_sha256, row_count, imported_at").eq("shift_id", id),
    supabase.from("handover_checklists").select("checklist_data, notes, submitted_at").eq("shift_id", id).order("submitted_at", { ascending: false }).limit(1),
    supabase.from("exceptions").select("exception_type, status, explanation, products(name)").eq("shift_id", id).neq("status", "superseded"),
  ]);

  const name = (x: unknown) => (x as { full_name: string } | null)?.full_name || "—";
  const final = (approvals ?? []).filter((a) => a.decision === "approved").at(-1);

  return (
    <main className="wrap" style={{ paddingTop: 24 }}>
      <p className="noprint"><Link href={`/shifts/${id}`}>Back to shift</Link></p>
      <h1>Shift reconciliation report</h1>
      <p className="lede">
        {s.businessName}, {(shift.locations as unknown as { name: string })?.name}. {shift.status === "approved" ? "Approved" : "Draft — not yet approved"}.
      </p>
      <table className="working sheet" style={{ display: "table" }}>
        <tbody>
          <tr><td>Opened</td><td>{when(shift.opened_at)} by {name(shift.opener)}</td></tr>
          <tr><td>Closed</td><td>{when(shift.closing_submitted_at)} by {name(shift.closer)}</td></tr>
          <tr><td>Reviewed</td><td>{final ? `${when(final.decided_at)} by ${name(final.profiles)}` : "Not yet"}</td></tr>
          <tr><td>Till file</td><td>{(imports ?? []).map((i) => `${i.file_name} (${i.row_count} lines, ref ${i.file_sha256.slice(0, 10)})`).join("; ") || "None"}</td></tr>
          <tr><td>Generated</td><td>{when(new Date().toISOString())}</td></tr>
        </tbody>
      </table>

      {recon && <ReconView recon={recon} />}

      <h2>Exceptions</h2>
      {(exceptions ?? []).length === 0 ? <p className="muted">None.</p> : (
        <table className="data">
          <thead><tr><th>Type</th><th>Status</th><th>Explanation</th></tr></thead>
          <tbody>
            {exceptions!.map((e, i) => (
              <tr key={i}>
                <td>{EXCEPTION_TYPE[e.exception_type]}{(e.products as unknown as { name: string } | null)?.name ? `: ${(e.products as unknown as { name: string }).name}` : ""}</td>
                <td>{e.status}</td>
                <td>{e.explanation || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Handover</h2>
      <p>{handover?.[0]?.notes || "No notes."}</p>

      <h2>Review history</h2>
      {(approvals ?? []).length === 0 ? <p className="muted">Not reviewed yet.</p> : (
        <ul>
          {approvals!.map((a, i) => (
            <li key={i}>{when(a.decided_at)}: {a.decision === "approved" ? "Approved" : "Returned"} by {name(a.profiles)}{a.notes ? `. ${a.notes}` : ""}</li>
          ))}
        </ul>
      )}

      <p className="muted small">
        Figures are calculated from recorded counts, movements, POS lines and settlements. Differences are reconciliation exceptions for review, not findings of fault.
      </p>
      <div className="row noprint" style={{ marginTop: 16 }}>
        <a className="button quiet" href={`/reports/${id}/csv`} download>Download CSV</a>
        <PrintButton />
      </div>
    </main>
  );
}
