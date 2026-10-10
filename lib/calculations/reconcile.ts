// Assemble a full shift reconciliation from raw rows — same shape as
// public.shift_reconciliation(). Used for live previews before submission.
import Decimal from "decimal.js";
import { cash, netSoldByProduct, salesValue, settlements, stockLine, type CashEvent, type Movement, type PosLine, type Settlement } from "./index";

export interface ReconcileInput {
  business: { cash_tolerance: Decimal.Value; stock_tolerance_pct: Decimal.Value };
  shift: { opening_float: Decimal.Value | null; counted_closing_cash: Decimal.Value | null };
  products: { id: string; sku: string; name: string; tracking_mode: string; base_unit: string; active: boolean }[];
  counts: { product_id: string; count_type: "opening" | "closing"; quantity: Decimal.Value; version: number }[];
  movements: Movement[];
  lines: PosLine[];
  events: CashEvent[];
  settlements: Settlement[];
}

export function latestCounts(counts: ReconcileInput["counts"]) {
  const out = new Map<string, Decimal.Value>();
  const ver = new Map<string, number>();
  for (const c of counts) {
    const k = `${c.product_id}:${c.count_type}`;
    if ((ver.get(k) ?? 0) < c.version) {
      ver.set(k, c.version);
      out.set(k, c.quantity);
    }
  }
  return out;
}

export function reconcile(input: ReconcileInput) {
  const latest = latestCounts(input.counts);
  const sold = netSoldByProduct(input.lines);

  const stock = input.products
    .filter((p) => p.active || latest.has(`${p.id}:opening`) || latest.has(`${p.id}:closing`))
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map((p) => {
      const opening = latest.get(`${p.id}:opening`) ?? null;
      const counted = latest.get(`${p.id}:closing`) ?? null;
      const r = stockLine({
        opening,
        counted_closing: counted,
        movements: input.movements.filter((m) => m.product_id === p.id),
        net_sold: sold.get(p.id) ?? 0,
        tolerance_pct: input.business.stock_tolerance_pct,
      });
      return {
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        tracking_mode: p.tracking_mode,
        base_unit: p.base_unit,
        opening: opening === null ? null : new Decimal(opening),
        counted_closing: counted === null ? null : new Decimal(counted),
        ...r,
      };
    });

  return {
    stock,
    sales: salesValue(input.lines),
    cash: cash({
      opening_float: input.shift.opening_float ?? 0,
      lines: input.lines,
      events: input.events,
      counted: input.shift.counted_closing_cash,
      tolerance: input.business.cash_tolerance,
    }),
    settlements: settlements(input.lines, input.settlements),
  };
}
