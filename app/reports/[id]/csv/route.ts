import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Guard against spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return new NextResponse("Sign in first", { status: 401 });

  const { data: recon, error } = await supabase.rpc("shift_reconciliation", { p_shift: id });
  if (error || !recon) return new NextResponse("Shift not found", { status: 404 });

  const rows: unknown[][] = [["section", "item", "expected", "actual", "difference", "status"]];
  for (const s of recon.stock) {
    rows.push(["stock", `${s.sku} ${s.name} (${s.base_unit})`, s.expected_closing, s.counted_closing, s.variance, s.status]);
  }
  if (recon.money_visible) {
    rows.push(["cash", "till", recon.cash.expected, recon.cash.counted, recon.cash.variance, recon.cash.status]);
    for (const x of recon.settlements) rows.push(["settlement", x.method, x.expected_net ?? x.pos_expected, x.net, x.variance, x.status]);
    rows.push(["sales", "list price vs POS gross", recon.sales.calculated_at_list, recon.sales.pos_gross_mapped, recon.sales.sales_value_variance, ""]);
    rows.push(["sales", "POS net sales", "", recon.sales.pos_net, "", ""]);
  }
  const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="onpoint-shift-${id.slice(0, 8)}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
