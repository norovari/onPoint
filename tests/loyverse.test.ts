import { describe, expect, test } from "vitest";
import { itemsToProducts, receiptsToRows, type LvReceipt } from "@/lib/pos/loyverse";
import { buildLines, collectItems, findHeaderRow, guessMapping, linkItems, type Product } from "@/lib/pos/smart";
import { categoryOf } from "@/lib/products/import";

const receipts: LvReceipt[] = [
  { receipt_number: "1-1001", receipt_type: "SALE", receipt_date: "2026-10-12T10:15:00.000Z",
    line_items: [
      { item_name: "Gelato", sku: "10001", quantity: 2, price: 120, gross_total_money: 240, total_money: 220, line_discounts: [{ money_amount: 20 }] },
      { item_name: "Pre-roll", variant_name: "Indoor", sku: "10002", quantity: 1, price: 90, total_money: 90 },
    ],
    payments: [{ name: "Cash", type: "CASH", money_amount: 310 }] },
  { receipt_number: "1-1002", receipt_type: "SALE", receipt_date: "2026-10-12T11:00:00.000Z",
    line_items: [{ item_name: "Gelato", sku: "10001", quantity: 1, price: 120, total_money: 120 }],
    payments: [{ name: "Card", type: "NONCASH", money_amount: 120 }] },
  { receipt_number: "1-1003", receipt_type: "REFUND", receipt_date: "2026-10-12T12:00:00.000Z",
    line_items: [{ item_name: "Pre-roll", variant_name: "Indoor", sku: "10002", quantity: 1, price: 90, total_money: 90 }],
    payments: [{ name: "Cash", type: "CASH", money_amount: 90 }] },
  { receipt_number: "1-1004", receipt_type: "SALE", cancelled_at: "2026-10-12T12:05:00.000Z",
    line_items: [{ item_name: "Gelato", sku: "10001", quantity: 5, total_money: 600 }], payments: [] },
];

describe("Loyverse sales", () => {
  test("receipts become till rows the normal import reads", () => {
    const rows = receiptsToRows(receipts);
    const h = findHeaderRow(rows);
    const { mapping, sure } = guessMapping(rows[h]);
    expect(sure).toBe(true);
    const products: Product[] = [
      { id: "p1", name: "Gelato", sku: "GEL", pos_code: "10001", base_unit: "g" },
      { id: "p2", name: "Pre-roll Indoor", sku: "PR", pos_code: "10002" },
    ];
    const body = rows.slice(h + 1);
    const l = linkItems(collectItems(body, mapping), products, {});
    const built = buildLines(body, mapping, l.linked, [], products, new Date(), "lv");
    expect(built.lines).toHaveLength(4); // cancelled receipt left out
    const gelato = built.lines.filter((x) => x.pos_code === "10001");
    expect(gelato.map((x) => x.quantity)).toEqual(["2", "1"]);
    expect(gelato[0].gross_amount).toBe("240.00"); // discount added back
    expect(gelato[0].payment_method).toBe("cash");
    expect(gelato[1].payment_method).toBe("card");
    const refund = built.lines.find((x) => x.is_refund)!;
    expect(refund.quantity).toBe("-1");
    expect(built.lines[0].external_ref).toBe("LV-1-1001-1");
  });
});

describe("Loyverse products", () => {
  test("items become products, skipping ones the shop has", () => {
    const { items, skipped } = itemsToProducts([
      { id: "a", item_name: "Gelato", sold_by_weight: true, variants: [{ sku: "10001", default_price: 120 }] },
      { id: "b", item_name: "Brownie", variants: [{ sku: "10003", default_price: 60 }] },
      { id: "c", item_name: "Old item", deleted_at: "2026-01-01", variants: [{ sku: "9", default_price: 1 }] },
      { id: "d", item_name: "Gift card", variants: [{ sku: "10009", default_price: null }] },
    ], [{ name: "Brownie", sku: "ED-1" }], categoryOf);
    expect(skipped).toBe(1);
    expect(items).toEqual([{ name: "Gelato", sku: "10001", pos_code: "10001", category: expect.any(String), weight: true, price: "120.00", low: null }]);
  });
});
