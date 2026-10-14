import { describe, it, expect } from "vitest";
import { toRows } from "@/lib/agrilink";

const base = { farmer: "Thabo Mokoena", phone: "082 123 4567", province: "Northern Cape", town: "Upington", delivery: "deliver" as const, notes: "", farm: "", consent: true };
const row = (crop: string, qty: string, unit = "crates", price = "", from = "") => ({ crop, qty, unit, price, from });

describe("AgriLink listings", () => {
  it("turns each crop into a row", () => {
    const { rows, error } = toRows({ ...base, crops: [row("Tomatoes", "50", "crates", "90", "2026-10-20"), row("Onions", "2,5", "tonnes")] }, "b1");
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(2);
    expect(rows![0]).toMatchObject({ crop: "Tomatoes", qty: 50, price: 90, available_from: "2026-10-20", province: "Northern Cape", delivery: "deliver", batch: "b1" });
    expect(rows![1]).toMatchObject({ qty: 2.5, unit: "tonnes", price: null, available_from: null });
  });
  it("skips empty crop rows", () => {
    expect(toRows({ ...base, crops: [row("Cabbage", "100", "heads"), row("", "")] }, "b").rows).toHaveLength(1);
  });
  it("needs consent, a number, a province and a crop", () => {
    expect(toRows({ ...base, consent: false, crops: [row("Cabbage", "1")] }, "b").error).toMatch(/tick/);
    expect(toRows({ ...base, phone: "12", crops: [row("Cabbage", "1")] }, "b").error).toMatch(/WhatsApp/);
    expect(toRows({ ...base, province: "Gautang", crops: [row("Cabbage", "1")] }, "b").error).toMatch(/province/);
    expect(toRows({ ...base, crops: [] }, "b").error).toMatch(/at least one/);
    expect(toRows({ ...base, crops: [row("Cabbage", "lots")] }, "b").error).toMatch(/How much Cabbage/);
    expect(toRows({ ...base, crops: [row("Cabbage", "5", "sacks")] }, "b").error).toMatch(/unit/);
  });
});
