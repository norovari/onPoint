import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePosCsv } from "@/lib/pos/csv";

const SAMPLE = readFileSync(join(import.meta.dirname, "..", "public", "sample-pos-export.csv"), "utf8");
const HEADER = "transaction_id,line_no,timestamp,pos_code,quantity,gross_amount,discount_amount,tax_amount,payment_method,line_type";

describe("POS CSV import", () => {
  test("the bundled sample parses cleanly and totals match the worked example", async () => {
    const r = await parsePosCsv(SAMPLE);
    expect(r.errors).toEqual([]);
    expect(r.lines).toHaveLength(6);
    expect(r.totals).toEqual({ sales: "750.00", refunds: "25.00" });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.lines.find((l) => l.external_ref === "T5-1")!.is_void).toBe(true);
  });

  test("same content gives the same hash (duplicate file detection)", async () => {
    expect((await parsePosCsv(SAMPLE)).sha256).toBe((await parsePosCsv(SAMPLE)).sha256);
  });

  test("missing columns are reported before anything else", async () => {
    const r = await parsePosCsv("transaction_id,quantity\n1,2");
    expect(r.errors[0]).toMatch(/Missing column\(s\): line_no, timestamp/);
    expect(r.lines).toHaveLength(0);
  });

  test("bad rows are reported with row numbers and excluded", async () => {
    const csv = [
      HEADER,
      "A,1,2026-10-10T08:00:00Z,P001,2,36.00,0,0,cash,sale",
      "A,1,2026-10-10T08:00:00Z,P001,2,36.00,0,0,cash,sale", // duplicate ref
      "B,1,not-a-date,P001,1,18.00,0,0,cash,sale",
      "C,1,2026-10-10T09:00:00Z,P001,1,18,0,0,bitcoin,sale",
      "D,1,2026-10-10T09:00:00Z,P001,1,18.00,0,0,cash,refund", // refund must be negative
      "E,1,2026-10-10T09:00:00Z,P001,1,eighteen,0,0,cash,sale",
    ].join("\n");
    const r = await parsePosCsv(csv);
    expect(r.lines).toHaveLength(1);
    expect(r.errors.join("\n")).toMatch(/Row 3: duplicate line A-1/);
    expect(r.errors.join("\n")).toMatch(/Row 4: timestamp/);
    expect(r.errors.join("\n")).toMatch(/Row 5: payment_method/);
    expect(r.errors.join("\n")).toMatch(/Row 6: refund lines need a negative/);
    expect(r.errors.join("\n")).toMatch(/Row 7: gross_amount "eighteen"/);
  });

  test("empty file", async () => {
    expect((await parsePosCsv(HEADER)).errors).toEqual(["The file contains no sales lines"]);
  });
});
