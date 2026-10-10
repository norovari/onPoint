import { notFound } from "next/navigation";
import Link from "next/link";
import { requireSession } from "@/lib/supabase/server";
import { EFT, LEGAL_NAME, planName } from "@/lib/plans";
import { formatZar } from "@/lib/calculations";
import { when } from "@/lib/labels";

export const metadata = { title: "Invoice" };

export default async function Invoice({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await requireSession();
  const { data: inv } = await s.supabase.from("invoices").select("*").eq("id", id).maybeSingle();
  if (!inv) notFound();

  return (
    <main className="wrap" style={{ paddingTop: 24, maxWidth: 640 }}>
      <p className="noprint"><Link href="/billing">Back to your plan</Link></p>
      <h1>Invoice {inv.number}</h1>
      <p className="lede">{LEGAL_NAME}</p>
      <div className="sheet">
        <table className="working"><tbody>
          <tr><td>Billed to</td><td>{s.businessName}</td></tr>
          <tr><td>Date</td><td>{when(inv.created_at)}</td></tr>
          <tr><td>OnPoint {planName(inv.plan)}, one month</td><td>{formatZar(inv.list_amount)}</td></tr>
          {inv.discount_pct > 0 && <tr><td>Launch discount ({inv.discount_pct}%)</td><td>−{formatZar(Number(inv.list_amount) - Number(inv.amount))}</td></tr>}
          <tr className="total"><td>Amount due</td><td>{formatZar(inv.amount)}</td></tr>
          <tr><td>Status</td><td>{inv.status === "paid" ? `Paid ${when(inv.paid_at)}` : inv.status === "pending" ? "Waiting for payment" : inv.status === "void" ? "Cancelled" : "Failed"}</td></tr>
        </tbody></table>
      </div>
      {inv.method === "eft" && inv.status === "pending" && (
        <div className="sheet" style={{ borderWidth: 2 }}>
          <h2 style={{ marginTop: 0 }}>Pay by EFT</h2>
          <table className="working"><tbody>
            <tr><td>Bank</td><td>{EFT.bank}</td></tr>
            <tr><td>Account name</td><td>{EFT.accountName}</td></tr>
            <tr><td>Account number</td><td>{EFT.accountNumber}</td></tr>
            <tr><td>Branch code</td><td>{EFT.branchCode}</td></tr>
            <tr className="total"><td>Reference (use exactly)</td><td>{inv.reference}</td></tr>
          </tbody></table>
          <p className="small muted" style={{ marginBottom: 0 }}>Your plan switches on as soon as we see the payment, usually within one working day.</p>
        </div>
      )}
      <p className="muted small">Print this page or save it as a PDF from your browser for your records.</p>
    </main>
  );
}
