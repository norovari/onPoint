import { describe, expect, it } from "vitest";
import { aboutTots, mlToReading, readingToMl, weighsBottle } from "@/lib/bottles";
import { buildProducts, categoryOf } from "@/lib/products/import";
import { mlFromName } from "@/lib/pos/smart";
import { itemsToProducts } from "@/lib/pos/loyverse";

const jameson = { base_unit: "ml", container_weight: "480", full_weight: "1180", bottle_ml: "750" };

describe("spirit bottles", () => {
  it("turns a scale reading into ml", () => {
    expect(readingToMl(1180, jameson).toNumber()).toBe(750);
    expect(readingToMl(480, jameson).toNumber()).toBe(0);
    // half the liquid weight left = half the bottle
    expect(readingToMl(830, jameson).toNumber()).toBe(375);
  });
  it("shows a saved count back as the same reading", () => {
    for (const ml of [0, 12.3, 375, 512.7, 750]) {
      const r = mlToReading(ml, jameson);
      expect(readingToMl(r, jameson).toNumber()).toBe(ml);
    }
  });
  it("needs empty, full and size to weigh a bottle", () => {
    expect(weighsBottle(jameson)).toBe(true);
    expect(weighsBottle({ ...jameson, full_weight: null })).toBe(false);
    expect(weighsBottle({ ...jameson, full_weight: "400" })).toBe(false);
    expect(weighsBottle({ ...jameson, base_unit: "g" })).toBe(false);
  });
  it("describes ml as tots", () => {
    expect(aboutTots(70)).toBe("about 3 tots");
    expect(aboutTots(-25)).toBe("about 1 tot");
    expect(aboutTots(10)).toBe("");
  });
  it("reads ml from till item names", () => {
    expect(mlFromName("Jameson double 50ml")).toBe(50);
    expect(mlFromName("Jameson tot")).toBe(null);
  });
});

describe("bar product lists", () => {
  it("sorts bar items into categories without touching dispensary ones", () => {
    expect(categoryOf("", "Jameson Irish whiskey")).toBe("Spirits");
    expect(categoryOf("", "Castle Lite")).toBe("Beer & cider");
    expect(categoryOf("", "Schweppes ginger ale")).toBe("Soft drinks & mixers");
    expect(categoryOf("", "Hookah: Double Apple")).toBe("Hookah");
    expect(categoryOf("", "Glass water pipe")).toBe("Accessories");
    expect(categoryOf("", "Infused soda")).not.toBe("Soft drinks & mixers");
    expect(categoryOf("", "Gelato 2g")).toBe("Flower");
  });
  it("keeps spirits in ml, priced per tot", () => {
    const rows = [["Jameson", "35"], ["Smirnoff 750ml bottle", "380"], ["Castle Lite", "30"]];
    const { items } = buildProducts(rows, { name: 0, price: 1 }, []);
    const by = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(by["Jameson"].ml).toBe(true);
    expect(by["Jameson"].price).toBe("1.4");
    expect(by["Smirnoff 750ml bottle"].ml).toBeUndefined();
    expect(by["Castle Lite"].ml).toBeUndefined();
  });
  it("brings Loyverse tots in as ml", () => {
    const { items } = itemsToProducts([{ id: "1", item_name: "Jameson tot", variants: [{ default_price: 35 }] }], [], categoryOf);
    expect(items[0]).toMatchObject({ ml: true, price: "1.4" });
  });
});
