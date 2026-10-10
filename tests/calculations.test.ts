import { describe, expect, test } from "vitest";
import Decimal from "decimal.js";
import { cash, formatQty, formatZar, netSoldByProduct, salesValue, settlementNet, settlements, stockLine, type PosLine } from "@/lib/calculations";

const n = (d: Decimal | null) => (d === null ? null : d.toNumber());

describe("stock", () => {
  test("blueprint example: 100 + 20 − 35 − 2 = 83, counted 79 → −4", () => {
    const r = stockLine({
      opening: 100,
      counted_closing: 79,
      movements: [
        { movement_type: "RECEIPT", quantity: 20 },
        { movement_type: "WASTAGE", quantity: 2 },
      ],
      net_sold: 35,
      tolerance_pct: 0,
    });
    expect(n(r.expected_closing)).toBe(83);
    expect(n(r.variance)).toBe(-4);
    expect(r.status).toBe("variance");
  });

  test("weighed stock stays exact (no float drift)", () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004
    const r = stockLine({
      opening: "0.1",
      counted_closing: "0.3",
      movements: [{ movement_type: "RECEIPT", quantity: "0.2" }],
      net_sold: 0,
      tolerance_pct: 0,
    });
    expect(r.variance!.isZero()).toBe(true);
    expect(r.status).toBe("matched");
  });

  test("signed adjustments and every outbound type", () => {
    const r = stockLine({
      opening: 1000,
      counted_closing: 900,
      movements: [
        { movement_type: "TRANSFER_IN", quantity: 50 },
        { movement_type: "TRANSFER_OUT", quantity: 30 },
        { movement_type: "DAMAGE", quantity: 5 },
        { movement_type: "INTERNAL_USE", quantity: 5 },
        { movement_type: "ADJUSTMENT", quantity: -10 },
      ],
      net_sold: 100,
      tolerance_pct: 0,
    });
    expect(n(r.expected_closing)).toBe(900);
    expect(r.status).toBe("matched");
  });

  test("tolerance is a percentage of expected", () => {
    const base = { opening: 1000, movements: [], net_sold: 0, tolerance_pct: 1 } as const;
    expect(stockLine({ ...base, counted_closing: 990 }).status).toBe("matched"); // −10 g within 1%
    expect(stockLine({ ...base, counted_closing: 989 }).status).toBe("variance");
  });

  test("a missing count is missing evidence, not zero", () => {
    expect(stockLine({ opening: null, counted_closing: 5, movements: [], net_sold: 0, tolerance_pct: 0 }).status).toBe("missing_evidence");
    const r = stockLine({ opening: 5, counted_closing: null, movements: [], net_sold: 0, tolerance_pct: 0 });
    expect(r.status).toBe("missing_evidence");
    expect(n(r.expected_closing)).toBe(5);
  });
});

const line = (p: Partial<PosLine>): PosLine => ({
  product_id: "a",
  quantity: 1,
  gross_amount: 10,
  discount_amount: 0,
  payment_method: "cash",
  is_refund: false,
  is_void: false,
  unit_price: 10,
  ...p,
});

describe("POS lines", () => {
  test("refunds reduce net sold; voids are ignored", () => {
    const m = netSoldByProduct([
      line({ quantity: 3 }),
      line({ quantity: -1, gross_amount: -10, is_refund: true }),
      line({ quantity: 5, is_void: true }),
    ]);
    expect(m.get("a")!.toNumber()).toBe(2);
  });

  test("sales value compares list price with POS gross on the same lines", () => {
    const s = salesValue([
      line({ quantity: 2, gross_amount: 20, discount_amount: 2 }),
      line({ quantity: 1, gross_amount: 8 }), // sold below list without a discount → variance
      line({ product_id: null, gross_amount: 5 }),
      line({ product_id: "b", unit_price: null }),
    ]);
    expect(s.calculated_at_list.toNumber()).toBe(30);
    expect(s.pos_gross_mapped.toNumber()).toBe(28);
    expect(s.sales_value_variance.toNumber()).toBe(2);
    expect(s.pos_discounts.toNumber()).toBe(2);
    expect(s.unmapped_lines).toBe(1);
    expect(s.unpriced_lines).toBe(1);
  });
});

describe("cash", () => {
  test("blueprint example: 500 + 3,200 − 100 − 2,000 = 1,600, counted 1,550 → −50", () => {
    const r = cash({
      opening_float: 500,
      lines: [line({ gross_amount: 3200 }), line({ gross_amount: -100, quantity: -1, is_refund: true }), line({ gross_amount: 999, payment_method: "card" })],
      events: [{ event_type: "REMOVED", amount: 2000 }],
      counted: 1550,
      tolerance: 0,
    });
    expect(r.expected.toNumber()).toBe(1600);
    expect(n(r.variance)).toBe(-50);
    expect(r.status).toBe("variance");
  });

  test("discounts reduce cash expected; paid-ins add; tolerance applies", () => {
    const r = cash({
      opening_float: 0,
      lines: [line({ gross_amount: 100, discount_amount: 10 })],
      events: [{ event_type: "PAID_IN", amount: 20 }, { event_type: "PAID_OUT", amount: 5 }, { event_type: "BANKED", amount: 50 }],
      counted: 54,
      tolerance: 1,
    });
    expect(r.expected.toNumber()).toBe(55);
    expect(r.status).toBe("matched");
  });

  test("no count yet → missing evidence", () => {
    expect(cash({ opening_float: 0, lines: [], events: [], counted: null, tolerance: 0 }).status).toBe("missing_evidence");
  });
});

describe("settlements", () => {
  test("next-day settlement is pending, not a loss", () => {
    const [r] = settlements([line({ payment_method: "card", gross_amount: 270 })], []);
    expect(r.status).toBe("pending");
    expect(r.variance).toBeNull();
  });

  test("fees are expected, not a variance", () => {
    const [r] = settlements([line({ payment_method: "card", gross_amount: 270 })], [
      { payment_method: "card", gross_amount: 270, refunds: 0, fees: 6.75, adjustments: 0, net_amount: 263.25 },
    ]);
    expect(r.status).toBe("matched");
    expect(n(r.expected_net)).toBe(263.25);
  });

  test("short settlement shows the gap", () => {
    const [r] = settlements([line({ payment_method: "eft", gross_amount: 1200 })], [
      { payment_method: "eft", gross_amount: 1150, refunds: 0, fees: 0, adjustments: 0, net_amount: 1150 },
    ]);
    expect(n(r.variance)).toBe(-50);
  });

  test("settlement net helper", () => {
    expect(settlementNet({ gross_amount: 270, fees: 6.75, refunds: 10, adjustments: -1 }).toNumber()).toBe(252.25);
  });
});

describe("formatting", () => {
  test("rand and units", () => {
    expect(formatZar(-50)).toBe("−R50.00");
    expect(formatZar("12450.5")).toBe("R12,450.50");
    expect(formatQty(2500, "g")).toBe("2.5 kg");
    expect(formatQty(250, "g")).toBe("250 g");
    expect(formatQty(83, "unit")).toBe("83");
  });
});
