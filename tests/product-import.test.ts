import { describe, expect, test } from "vitest";
import Papa from "papaparse";
import { detectDelimiter } from "@/lib/pos/smart";
import { buildProducts, findProductHeader, guessProductColumns, categoryOf } from "@/lib/products/import";

const read = (csv: string) => Papa.parse<string[]>(csv.trim(), { delimiter: detectDelimiter(csv) }).data;
function run(csv: string, existing: { name: string; sku: string }[] = []) {
  const rows = read(csv);
  const h = findProductHeader(rows);
  const g = guessProductColumns(rows[h]);
  return { ...g, ...buildProducts(rows.slice(h + 1), g.mapping, existing) };
}

describe("uploading a product list", () => {
  test("a typical menu export", () => {
    const r = run(`Product Name,SKU,Category,Unit,Price,Reorder Level
Gelato,GEL-1,Flower,gram,"R55,00",20
Gelato Pre-roll,,Pre-rolls,each,50,6
Sour Gummies 10 pack,ED-9,,each,120,
Rolling papers,,Accessories,each,15,10`);
    expect(r.sure).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.items.map((i) => [i.name, i.sku, i.category, i.weight, i.price, i.low])).toEqual([
      ["Gelato", "GEL-1", "Flower", true, "55", "20"],
      ["Gelato Pre-roll", "GELATO-PRE-ROLL", "Pre-rolls", false, "50", "6"],
      ["Sour Gummies 10 pack", "ED-9", "Edibles", false, "120", null],
      ["Rolling papers", "ROLLING-PAPERS", "Accessories", false, "15", "10"],
    ]);
  });

  test("names only with prices: weight and category worked out; per-kg converted; existing skipped", () => {
    const r = run(`Item;Price;Sold by
Northern Lights indoor;90;g
Runtz;140000;per kg
Brownie (100mg);110;unit
Runtz;150;g`, [{ name: "Brownie (100mg)", sku: "ED-BRW" }]);
    expect(r.items.map((i) => [i.name, i.weight, i.price])).toEqual([["Northern Lights indoor", true, "90"], ["Runtz", true, "140"]]);
    expect(r.skipped).toBe(2);
  });

  test("categories from names", () => {
    expect(categoryOf("", "1ml vape cartridge")).toBe("Vapes & extracts");
    expect(categoryOf("", "Choc chip cookie")).toBe("Edibles");
    expect(categoryOf("", "Mystery")).toBe("Other");
  });
});
