import Link from "next/link";
import { requireSession } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { SHIFT_STATUS, when } from "@/lib/labels";

export const metadata = { title: "Shifts" };

export default async function Shifts({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const s = await requireSession();
  let q = s.supabase
    .from("shifts")
    .select("id, status, opened_at, closing_submitted_at, locations(name), opener:profiles!shifts_opened_by_fkey(full_name)")
    .order("opened_at", { ascending: false })
    .limit(100);
  if (status && SHIFT_STATUS[status]) q = q.eq("status", status);
  const { data } = await q;

  return (
    <Shell businessName={s.businessName}>
      <h1>Shifts</h1>
      <nav className="nav" aria-label="Filter shifts" style={{ margin: "8px 0 16px" }}>
        <Link href="/shifts" aria-current={!status ? "page" : undefined}>All</Link>
        {Object.entries(SHIFT_STATUS).map(([k, v]) => (
          <Link key={k} href={`/shifts?status=${k}`} aria-current={status === k ? "page" : undefined}>{v.label}</Link>
        ))}
      </nav>
      {data?.length ? (
        <ul className="lines">
          {data.map((r) => {
            const st = SHIFT_STATUS[r.status];
            return (
              <li key={r.id} className="line" data-status={st.tone === "neutral" ? undefined : st.tone}>
                <Link href={`/shifts/${r.id}`} className="name">
                  {(r.locations as unknown as { name: string } | null)?.name}, {when(r.opened_at)}
                </Link>
                <span className="status" data-status={st.tone}>{st.label}</span>
                <span className="meta">Opened by {(r.opener as unknown as { full_name: string } | null)?.full_name || "—"}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">No shifts match this filter.</p>
      )}
    </Shell>
  );
}
