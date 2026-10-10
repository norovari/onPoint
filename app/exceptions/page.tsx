import Link from "next/link";
import { requireSession, isManager } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { updateException } from "@/app/actions";
import { formatQty, formatZar } from "@/lib/calculations";
import { EXCEPTION_TYPE, when } from "@/lib/labels";

export const metadata = { title: "Exceptions" };

export default async function Exceptions({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const s = await requireSession();
  const closed = show === "closed";
  const { data } = await s.supabase
    .from("exceptions")
    .select("id, shift_id, exception_type, stage, expected, actual, difference, severity, status, explanation, created_at, payment_method, products(name, base_unit), shifts(opened_at, locations(name))")
    .in("status", closed ? ["resolved", "superseded"] : ["open", "explained"])
    .order("created_at", { ascending: false })
    .limit(200);

  const isMoney = (t: string) => ["cash_variance", "settlement_variance", "sales_value_variance", "opening_float_variance"].includes(t);

  return (
    <Shell businessName={s.businessName}>
      <h1>Exceptions</h1>
      <p className="lede">
        Differences the system found between what was recorded and what was counted or settled. A difference is something to look into. It is not proof of wrongdoing.
      </p>
      <nav className="nav" aria-label="Filter" style={{ marginBottom: 16 }}>
        <Link href="/exceptions" aria-current={!closed ? "page" : undefined}>Needs attention</Link>
        <Link href="/exceptions?show=closed" aria-current={closed ? "page" : undefined}>Closed</Link>
      </nav>

      {!data?.length && <p className="notice ok">{closed ? "Nothing closed yet." : "Nothing needs attention right now."}</p>}

      {data?.map((e) => {
        const p = e.products as unknown as { name: string; base_unit: string } | null;
        const sh = e.shifts as unknown as { opened_at: string; locations: { name: string } } | null;
        const fmt = (v: unknown) => (isMoney(e.exception_type) ? formatZar(v as string) : formatQty(v as string, p?.base_unit ?? "unit"));
        const tone = e.status === "explained" ? "pending" : e.status === "open" ? "variance" : "matched";
        return (
          <div key={e.id} className="sheet" style={{ borderLeft: `5px solid var(--${tone})` }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <h3>{EXCEPTION_TYPE[e.exception_type]}{p ? `: ${p.name}` : ""}{e.payment_method && !p ? ` (${e.payment_method})` : ""}</h3>
              {e.difference !== null && <span className="diff" data-status="variance" style={{ fontSize: 20 }}>{fmt(e.difference)}</span>}
            </div>
            <p className="muted small" style={{ margin: "2px 0 8px" }}>
              <Link href={`/shifts/${e.shift_id}`}>{sh?.locations?.name}, shift of {when(sh?.opened_at)}</Link>
              {e.stage === "opening" ? ", found at opening" : ""}
              {e.expected !== null && <>. Expected {fmt(e.expected)}, found {fmt(e.actual)}.</>}
            </p>
            {e.explanation && <p style={{ whiteSpace: "pre-wrap", margin: "0 0 8px" }}>{e.explanation}</p>}
            {!closed && (
              <ActionForm action={updateException} hidden={{ exception_id: e.id }}>
                <label htmlFor={`ex-${e.id}`}>{isManager(s.role) ? "Explanation or resolution" : "Explanation"}</label>
                <textarea id={`ex-${e.id}`} name="explanation" rows={2} required />
                <div className="row" style={{ marginTop: 10 }}>
                  <Submit className="quiet" name="status" value="explained">Save explanation</Submit>
                  {isManager(s.role) && <Submit name="status" value="resolved">Resolve</Submit>}
                </div>
              </ActionForm>
            )}
          </div>
        );
      })}
    </Shell>
  );
}
