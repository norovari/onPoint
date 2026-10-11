import { describe, expect, test } from "vitest";
import Papa from "papaparse";
import { buildLines, collectItems, detectDelimiter, findHeaderRow, guessMapping, linkItems, parseDateTime, parseMoney, paymentOf, type Product } from "@/lib/pos/smart";

const products: Product[] = [
  { id: "p-gelato", name: "Greenhouse flower: Gelato", sku: "FL-GH1", pos_code: "FL04" },
  { id: "p-runtz", name: "Indoor AAA flower: Runtz", sku: "FL-AAA", pos_code: "FL07" },
  { id: "p-gummy", name: "Gummies, 10 pack (100mg)", sku: "ED-GUM", pos_code: "ED01" },
];
const rowsOf = (csv: string) => Papa.parse<string[]>(csv.trim(), { delimiter: detectDelimiter(csv), skipEmptyLines: false }).data;

function run(csv: string, links: Record<string, string> = {}, skip: string[] = []) {
  const rows = rowsOf(csv);
  const h = findHeaderRow(rows);
  const { mapping, sure } = guessMapping(rows[h]);
  const body = rows.slice(h + 1);
  const l = linkItems(collectItems(body, mapping), products, { links, skip });
  const built = buildLines(body, mapping, { ...l.linked, ...links }, skip, products, new Date("2026-10-11T10:00:00Z"), "abc123");
  return { h, mapping, sure, ...l, built };
}

describe("reading any till export", () => {
  test("numbers and dates the way SA tills write them", () => {
    expect(parseMoney("R 1 234,50")!.toString()).toBe("1234.5");
    expect(parseMoney("1,234.50")!.toString()).toBe("1234.5");
    expect(parseMoney("(12.00)")!.toString()).toBe("-12");
    expect(parseMoney("12,5")!.toString()).toBe("12.5");
    expect(parseMoney("abc")).toBeNull();
    expect(parseDateTime("10/10/2026", "14:05")!.toISOString()).toBe("2026-10-10T12:05:00.000Z");
    expect(parseDateTime("2026-10-10 09:30")!.toISOString()).toBe("2026-10-10T07:30:00.000Z");
    expect(parseDateTime("10 Oct 2026 2:15 pm")!.toISOString()).toBe("2026-10-10T12:15:00.000Z");
    expect(parseDateTime("2026-10-10T08:15:00+02:00")!.toISOString()).toBe("2026-10-10T06:15:00.000Z");
    expect(paymentOf("Yoco Card")).toBe("card");
    expect(paymentOf("CASH")).toBe("cash");
    expect(paymentOf("SnapScan")).toBe("eft");
  });

  test("OnPoint's own format still works", () => {
    const r = run(`transaction_id,line_no,timestamp,pos_code,quantity,gross_amount,discount_amount,tax_amount,payment_method,line_type
T1,1,2026-10-10T08:15:00+02:00,FL04,2,110.00,0.00,14.35,cash,sale
T2,1,2026-10-10T09:02:00+02:00,ED01,1,120.00,0.00,15.65,card,sale`);
    expect(r.sure).toBe(true);
    expect(r.unmatched).toEqual([]);
    expect(r.built.errors).toEqual([]);
    expect(r.built.totals.sales).toBe("230.00");
    expect(r.built.byMethod).toEqual({ cash: "110.00", card: "120.00" });
  });

  test("a card-machine style export with receipt numbers, names and prices", () => {
    const r = run(`Date,Time,Receipt No,Item,Quantity,Price,Total,Payment Type
11/10/2026,10:05,1001,Greenhouse flower: Gelato,3.5g,"R55,00","R192,50",Card
11/10/2026,10:05,1001,Rolling papers,1,15,15,Card
11/10/2026,10:20,1002,Gummies 10 pack (100mg),1,120,120,Cash
11/10/2026,11:00,1003,Greenhouse flower: Gelato,-1,55,-55,Cash`, {}, ["rolling papers"]);
    expect(r.sure).toBe(true);
    expect(r.built.skipped).toBe(1);
    expect(r.linked["greenhouse flower: gelato"]).toBe("p-gelato");
    expect(r.linked["gummies 10 pack (100mg)"]).toBe("p-gummy"); // punctuation ignored
    expect(r.built.lines).toHaveLength(3);
    expect(r.built.lines[0]).toMatchObject({ external_ref: "1001-1", pos_code: "FL04", quantity: "3.5", gross_amount: "192.50", payment_method: "card" });
    expect(r.built.lines[2]).toMatchObject({ is_refund: true, quantity: "-1", gross_amount: "-55.00" });
    expect(r.built.totals).toEqual({ sales: "312.50", refunds: "55.00" });
  });

  test("a summary report with title lines, semicolons and comma decimals", () => {
    const r = run(`Sales by item
Period: 11/10/2026 - 11/10/2026

Item Name;Qty Sold;Gross Sales
Runtz;12,5;R 1 750,00
Mystery item;2;100
Total;14,5;1850`.replace(/;/g, ";"));
    expect(r.h).toBe(3);
    expect(r.unmatched.map((u) => u.name)).toEqual(["Runtz", "Mystery item"]);
    const linked = run(`Item Name;Qty Sold;Gross Sales
Runtz;12,5;R 1 750,00`, { runtz: "p-runtz" });
    expect(linked.built.lines[0]).toMatchObject({ pos_code: "FL07", quantity: "12.5", gross_amount: "1750.00", payment_method: "other" });
    expect(linked.built.hasPayment).toBe(false);
    expect(linked.built.lines[0].external_ref).toBe("abc123-1");
  });

  test("an export with SKUs, discounts and voids", () => {
    const r = run(`Sale ID,Sale Date,Item SKU,Description,Qty,Discount,Tax,Total,Tender,Status
S9,2026-10-11 15:00,FL-AAA,Runtz,2,20.00,33.39,260.00,Visa,Completed
S9,2026-10-11 15:00,ED-GUM,Gummies,1,0,15.65,120.00,Visa,Void`);
    expect(r.mapping.code).toBe(2);
    expect(r.built.lines[0]).toMatchObject({ pos_code: "FL07", gross_amount: "280.00", discount_amount: "20.00", is_void: false });
    expect(r.built.lines[1].is_void).toBe(true);
    expect(r.built.totals.sales).toBe("260.00");
  });

  test("tells you when it can't find the columns", () => {
    const r = run(`a,b,c\n1,2,3`);
    expect(r.sure).toBe(false);
  });
});
