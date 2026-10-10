import Link from "next/link";
import { requireSession, isManager } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { openShift } from "@/app/actions";
import { SHIFT_STATUS, when } from "@/lib/labels";

export default async function Today() {
  const s = await requireSession();
  const { supabase } = s;

  const [{ data: locations }, { data: inProgress }, { data: recent }, { count: openExceptions }, { count: products }] = await Promise.all([
    supabase.from("locations").select("id, name, standard_float").eq("active", true).order("name"),
    supabase
      .from("shifts")
      .select("id, location_id, status, opened_at, profiles!shifts_opened_by_fkey(full_name)")
      .neq("status", "approved")
      .order("opened_at", { ascending: false }),
    supabase.from("shifts").select("id, status, opened_at, locations(name)").order("opened_at", { ascending: false }).limit(5),
    supabase.from("exceptions").select("id", { count: "exact", head: true }).in("status", ["open", "explained"]),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("active", true),
  ]);

  const busy = new Set((inProgress ?? []).map((x) => x.location_id));
  const free = (locations ?? []).filter((l) => !busy.has(l.id));
  const waiting = (inProgress ?? []).filter((x) => x.status === "closing_submitted");

  return (
    <Shell businessName={s.businessName}>
      <h1>Today</h1>
      <p className="lede">Hi {s.fullName.split(" ")[0] || "there"}. Here’s where every till stands.</p>

      {products === 0 && (
        <p className="notice">
          Add your products before the first shift.{" "}
          {s.role === "owner" ? <Link href="/settings">Add products</Link> : "Ask the owner to add them."}
        </p>
      )}

      {(inProgress ?? []).map((x) => {
        const st = SHIFT_STATUS[x.status];
        const loc = locations?.find((l) => l.id === x.location_id);
        const opener = (x.profiles as unknown as { full_name: string } | null)?.full_name;
        return (
          <Link key={x.id} href={`/shifts/${x.id}`} className="sheet" style={{ display: "block", color: "inherit", textDecoration: "none" }}>
            <span className="status" data-status={st.tone}>{st.label}</span>
            <h2 style={{ margin: "8px 0 2px" }}>{loc?.name ?? "Shift"}</h2>
            <p className="muted small" style={{ margin: 0 }}>
              Opened {when(x.opened_at)}{opener ? ` by ${opener}` : ""}
            </p>
            <p style={{ margin: "10px 0 0", fontWeight: 700, color: "var(--signal)" }}>
              {x.status === "closing_submitted" && isManager(s.role) ? "Review shift" : "Continue shift"}
            </p>
          </Link>
        );
      })}

      {free.length > 0 && (
        <ActionForm action={openShift} className="sheet">
          <h2 style={{ marginTop: 0 }}>Open a shift</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Count the cash in the till first. You’ll count stock on the next screen.
          </p>
          {free.length > 1 ? (
            <>
              <label htmlFor="location">Location</label>
              <select id="location" name="location">
                {free.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </>
          ) : (
            <input type="hidden" name="location" value={free[0].id} />
          )}
          <label htmlFor="float">Cash in the till now (R)</label>
          <input id="float" name="float" type="number" inputMode="decimal" step="0.01" min="0" required placeholder={String(free[0].standard_float)} />
          <div style={{ marginTop: 14 }}>
            <Submit>Open shift</Submit>
          </div>
        </ActionForm>
      )}

      <div className="figures">
        <Link href="/exceptions" className="figure" style={{ color: "inherit", textDecoration: "none" }}>
          <div className="value" style={{ color: openExceptions ? "var(--variance)" : "var(--matched)" }}>{openExceptions ?? 0}</div>
          <div className="label">open exceptions</div>
        </Link>
        {isManager(s.role) && (
          <div className="figure">
            <div className="value">{waiting.length}</div>
            <div className="label">waiting for review</div>
          </div>
        )}
      </div>

      <h2>Recent shifts</h2>
      {recent?.length ? (
        <ul className="lines">
          {recent.map((r) => {
            const st = SHIFT_STATUS[r.status];
            return (
              <li key={r.id} className="line" data-status={st.tone === "neutral" ? undefined : st.tone}>
                <Link href={`/shifts/${r.id}`} className="name">
                  {(r.locations as unknown as { name: string } | null)?.name}, {when(r.opened_at)}
                </Link>
                <span className="status" data-status={st.tone}>{st.label}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">No shifts yet. Open your first one above.</p>
      )}
    </Shell>
  );
}
