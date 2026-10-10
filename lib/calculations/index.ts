// OnPoint reconciliation formulas.
//
// These mirror public.shift_reconciliation() in the database exactly. The
// database version is authoritative (it is what gets snapshotted on submit);
// this version powers live previews on staff phones as they type counts.
// tests/sql-parity.test.ts checks both give identical answers.
//
// All arithmetic uses decimal.js — never JavaScript floats — because
// 0.1 + 0.2 !== 0.3 and weighed stock / money must be exact.
import Decimal from "decimal.js";

export type Num = Decimal.Value;
export type Status = "matched" | "variance" | "pending" | "missing_evidence";
export type PaymentMethod = "cash" | "card" | "eft" | "other";
export type MovementType =
  | "RECEIPT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "WASTAGE"
  | "DAMAGE"
  | "INTERNAL_USE"
  | "ADJUSTMENT";
export type CashEventType = "PAID_IN" | "PAID_OUT" | "REMOVED" | "BANKED";

const D = (v: Num | null | undefined) => new Decimal(v ?? 0);
const sum = (vals: Num[]) => vals.reduce<Decimal>((a, v) => a.plus(v), new Decimal(0));

// ---------------------------------------------------------------------------
// A. Stock
// Expected closing = opening + receipts + transfers in + adjustments
//                  − net sold − transfers out − wastage − damage − internal use
// Variance = counted closing − expected closing
// ---------------------------------------------------------------------------
export interface Movement {
  product_id: string;
  movement_type: MovementType;
  quantity: Num; // positive, except ADJUSTMENT which is signed
}

export interface StockLineInput {
  opening: Num | null;
  counted_closing: Num | null;
  movements: readonly Pick<Movement, "movement_type" | "quantity">[];
  net_sold: Num; // from POS lines, refunds already negative
  tolerance_pct: Num;
}

export interface StockLineResult {
  receipts: Decimal;
  transfers_in: Decimal;
  transfers_out: Decimal;
  wastage: Decimal;
  damage: Decimal;
  internal_use: Decimal;
  adjustments: Decimal;
  net_sold: Decimal;
  expected_closing: Decimal | null;
  variance: Decimal | null;
  status: Exclude<Status, "pending">;
}

export function stockLine(input: StockLineInput): StockLineResult {
  const by = (t: MovementType) => sum(input.movements.filter((m) => m.movement_type === t).map((m) => m.quantity));
  const r = {
    receipts: by("RECEIPT"),
    transfers_in: by("TRANSFER_IN"),
    transfers_out: by("TRANSFER_OUT"),
    wastage: by("WASTAGE"),
    damage: by("DAMAGE"),
    internal_use: by("INTERNAL_USE"),
    adjustments: by("ADJUSTMENT"),
    net_sold: D(input.net_sold),
  };

  if (input.opening === null) {
    return { ...r, expected_closing: null, variance: null, status: "missing_evidence" };
  }
  const expected = D(input.opening)
    .plus(r.receipts)
    .plus(r.transfers_in)
    .plus(r.adjustments)
    .minus(r.net_sold)
    .minus(r.transfers_out)
    .minus(r.wastage)
    .minus(r.damage)
    .minus(r.internal_use);

  if (input.counted_closing === null) {
    return { ...r, expected_closing: expected, variance: null, status: "missing_evidence" };
  }
  const variance = D(input.counted_closing).minus(expected);
  const allowed = expected.abs().times(D(input.tolerance_pct)).dividedBy(100);
  return {
    ...r,
    expected_closing: expected,
    variance,
    status: variance.abs().lte(allowed) ? "matched" : "variance",
  };
}

// ---------------------------------------------------------------------------
// POS line helpers
// ---------------------------------------------------------------------------
export interface PosLine {
  product_id: string | null;
  quantity: Num; // negative for refunds
  gross_amount: Num; // negative for refunds
  discount_amount: Num;
  payment_method: PaymentMethod;
  is_refund: boolean;
  is_void: boolean;
  unit_price?: Num | null; // list price per base unit at transaction time
}

const live = (lines: PosLine[]) => lines.filter((l) => !l.is_void);
const net = (l: PosLine) => D(l.gross_amount).minus(D(l.discount_amount));

export function netSoldByProduct(lines: PosLine[]): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const l of live(lines)) {
    if (!l.product_id) continue;
    out.set(l.product_id, (out.get(l.product_id) ?? new Decimal(0)).plus(l.quantity));
  }
  return out;
}

// ---------------------------------------------------------------------------
// B. Sales value
// Calculated at list = Σ quantity × price at transaction time
// Sales value variance = calculated at list − POS gross (same lines, both
// before discount and tax-inclusive). Discounts are reported separately.
// ---------------------------------------------------------------------------
export function salesValue(lines: PosLine[]) {
  const l = live(lines);
  const priced = l.filter((x) => x.product_id && x.unit_price !== null && x.unit_price !== undefined);
  const calculated = sum(priced.map((x) => D(x.quantity).times(D(x.unit_price!)))).toDecimalPlaces(2);
  const posGrossMapped = sum(priced.map((x) => x.gross_amount));
  return {
    pos_gross: sum(l.map((x) => x.gross_amount)),
    pos_discounts: sum(l.map((x) => x.discount_amount)),
    pos_net: sum(l.map(net)),
    pos_refunds: sum(l.filter((x) => x.is_refund).map((x) => x.gross_amount)).negated(),
    calculated_at_list: calculated,
    pos_gross_mapped: posGrossMapped,
    sales_value_variance: calculated.minus(posGrossMapped),
    unmapped_lines: l.filter((x) => !x.product_id).length,
    unpriced_lines: l.filter((x) => x.product_id && (x.unit_price === null || x.unit_price === undefined)).length,
  };
}

// ---------------------------------------------------------------------------
// C. Cash in the till
// Expected = opening float + cash sales − cash refunds + paid in
//          − paid out − removed − banked
// Variance = counted − expected
// ---------------------------------------------------------------------------
export interface CashEvent {
  event_type: CashEventType;
  amount: Num;
}

export function cash(input: {
  opening_float: Num;
  lines: PosLine[];
  events: CashEvent[];
  counted: Num | null;
  tolerance: Num;
}) {
  const c = live(input.lines).filter((l) => l.payment_method === "cash");
  const cash_sales = sum(c.filter((l) => !l.is_refund).map(net));
  const cash_refunds = sum(c.filter((l) => l.is_refund).map(net)).negated();
  const ev = (t: CashEventType) => sum(input.events.filter((e) => e.event_type === t).map((e) => e.amount));
  const paid_in = ev("PAID_IN");
  const paid_out = ev("PAID_OUT");
  const removed = ev("REMOVED");
  const banked = ev("BANKED");
  const expected = D(input.opening_float)
    .plus(cash_sales)
    .minus(cash_refunds)
    .plus(paid_in)
    .minus(paid_out)
    .minus(removed)
    .minus(banked);
  const variance = input.counted === null ? null : D(input.counted).minus(expected);
  const status: Status =
    variance === null ? "missing_evidence" : variance.abs().lte(D(input.tolerance)) ? "matched" : "variance";
  return {
    opening_float: D(input.opening_float),
    cash_sales,
    cash_refunds,
    paid_in,
    paid_out,
    removed,
    banked,
    expected,
    counted: input.counted === null ? null : D(input.counted),
    variance,
    status,
  };
}

// ---------------------------------------------------------------------------
// D. Card / EFT settlement
// Expected net = POS net for the method − processor fees + adjustments
// Variance     = settled net − expected net
// No settlement yet → "pending" (never treated as a loss)
// ---------------------------------------------------------------------------
export interface Settlement {
  payment_method: Exclude<PaymentMethod, "cash">;
  gross_amount: Num;
  refunds: Num;
  fees: Num;
  adjustments: Num;
  net_amount: Num;
}

export function settlements(lines: PosLine[], records: Settlement[]) {
  const methods = new Set<string>();
  live(lines).filter((l) => l.payment_method !== "cash").forEach((l) => methods.add(l.payment_method));
  records.forEach((r) => methods.add(r.payment_method));

  return [...methods].sort().map((method) => {
    const pos_expected = sum(live(lines).filter((l) => l.payment_method === method).map(net));
    const recs = records.filter((r) => r.payment_method === method);
    if (recs.length === 0) {
      return { method, pos_expected, expected_net: null, net: null, fees: null, variance: null, status: "pending" as Status };
    }
    const fees = sum(recs.map((r) => r.fees));
    const adjustments = sum(recs.map((r) => r.adjustments));
    const settledNet = sum(recs.map((r) => r.net_amount));
    const expected_net = pos_expected.minus(fees).plus(adjustments);
    const variance = settledNet.minus(expected_net);
    return {
      method,
      pos_expected,
      expected_net,
      net: settledNet,
      fees,
      variance,
      status: (variance.isZero() ? "matched" : "variance") as Status,
    };
  });
}

// ---------------------------------------------------------------------------
// Settlement record helper: net must equal gross − fees − refunds + adjustments
// ---------------------------------------------------------------------------
export function settlementNet(r: Pick<Settlement, "gross_amount" | "fees" | "refunds" | "adjustments">) {
  return D(r.gross_amount).minus(D(r.fees)).minus(D(r.refunds)).plus(D(r.adjustments));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function formatQty(v: Decimal.Value | null | undefined, baseUnit: string) {
  if (v === null || v === undefined) return "—";
  const d = new Decimal(v);
  if (baseUnit === "g" && d.abs().gte(1000)) return `${d.dividedBy(1000).toDecimalPlaces(3).toString()} kg`;
  if (baseUnit === "unit") return `${d.toDecimalPlaces(3).toString()}`;
  return `${d.toDecimalPlaces(3).toString()} ${baseUnit}`;
}

export function formatZar(v: Decimal.Value | null | undefined) {
  if (v === null || v === undefined) return "—";
  const d = new Decimal(v).toDecimalPlaces(2);
  const sign = d.isNegative() ? "−" : "";
  const [whole, cents] = d.abs().toFixed(2).split(".");
  return `${sign}R${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}
