import Link from "next/link";
import { requireSession, isManager } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { updateException } from "@/app/actions";
import { ReasonFields } from "@/components/ReasonFields";
import { formatQty, formatZar } from "@/lib/calculations";
import { EXCEPTION_TYPE, when } from "@/lib/labels";

export const metadata = { title: "Needs review" };

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
      <h1>Needs review</h1>
      <p className="lede">
        These are differences between what was recorded and what was counted or paid. They need checking, but they don’t prove that anyone did something wrong.
      </p>
      <nav className="nav" aria-label="Filter" style={{ marginBottom: 16 }}>
        <Link href="/exceptions" aria-current={!closed ? "page" : undefined}>Needs review</Link>
        <Link href="/exceptions?show=closed" aria-current={closed ? "page" : undefined}>Done</Link>
      </nav>

      {!data?.length && <p className="notice ok">{closed ? "Nothing marked as done yet." : "Nothing to review right now."}</p>}

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
              {e.stage === "opening" ? " · Difference found at opening" : ""}
              {e.expected !== null && <> · Counted {fmt(e.actual)} · Expected {fmt(e.expected)}</>}
            </p>
            {e.explanation && <p style={{ whiteSpace: "pre-wrap", margin: "0 0 8px" }}>{e.explanation}</p>}
            {!closed && (
              <ActionForm action={updateException} hidden={{ exception_id: e.id }}>
                <ReasonFields id={e.id} label="Explain what happened or how it was fixed" />
                <div className="row" style={{ marginTop: 10 }}>
                  <Submit className="quiet" name="status" value="explained">Save explanation</Submit>
                  {isManager(s.role) && <Submit name="status" value="resolved">Mark as done</Submit>}
                </div>
              </ActionForm>
            )}
          </div>
        );
      })}
    </Shell>
  );
}
