// Reads a product list (CSV or Excel, any layout) so a shop can bring in its
// whole menu at once: name, code, category, sold by weight or unit, price,
// and the low-stock level.
import Decimal from "decimal.js";
import { parseMoney } from "@/lib/pos/smart";
import { TOT_ML } from "@/lib/bottles";

export type PField = "name" | "sku" | "pos" | "category" | "unit" | "price" | "low";

export const PFIELDS: { key: PField; label: string; required?: boolean }[] = [
  { key: "name", label: "Product name", required: true },
  { key: "price", label: "Selling price (R)", required: true },
  { key: "sku", label: "Code / SKU" },
  { key: "pos", label: "Code on the till (if different)" },
  { key: "category", label: "Category" },
  { key: "unit", label: "Sold by (gram or unit)" },
  { key: "low", label: "Warn when stock is below" },
];

export const CATEGORIES = ["Flower", "Pre-rolls", "Edibles", "Vapes & extracts", "Accessories", "Spirits", "Beer & cider", "Wine", "Soft drinks & mixers", "Hookah", "Other"];

const HINTS: Record<PField, RegExp> = {
  name: /^(product|product name|item|item name|name|description|strain|product description)$/,
  sku: /^(sku|code|item code|product code|stock code|barcode|plu|id)$/,
  pos: /^(pos code|till code|pos|plu code)$/,
  category: /^(category|type|group|department|product type|class)$/,
  unit: /^(unit|uom|sold by|unit of measure|measure|per)$/,
  price: /^(price|selling price|sell price|retail|retail price|price per gram|price per unit|unit price|rand|price \(r\)|price r)$/,
  low: /^(low stock|low stock level|reorder|reorder level|min|minimum|min stock|warn below|par)$/,
};
const norm = (h: string) => (h ?? "").toString().toLowerCase().replace(/[_\-./#:]+/g, " ").replace(/\s+/g, " ").trim();

export function findProductHeader(rows: string[][]) {
  let best = 0, score = -1;
  rows.slice(0, 15).forEach((r, i) => {
    const s = r.filter((c) => Object.values(HINTS).some((h) => h.test(norm(c)))).length;
    if (s > score) { best = i; score = s; }
  });
  return best;
}

export function guessProductColumns(headers: string[]) {
  const m: Partial<Record<PField, number>> = {};
  const used = new Set<number>();
  const H = headers.map(norm);
  for (const f of Object.keys(HINTS) as PField[]) {
    const i = H.findIndex((h, j) => !used.has(j) && HINTS[f].test(h));
    if (i >= 0) { m[f] = i; used.add(i); }
  }
  // Looser second pass for the two we need
  if (m.name === undefined) { const i = H.findIndex((h, j) => !used.has(j) && /product|item|name|strain/.test(h)); if (i >= 0) { m.name = i; used.add(i); } }
  if (m.price === undefined) { const i = H.findIndex((h, j) => !used.has(j) && /price|rand|cost|amount/.test(h) && !/cost price|buy/.test(h)); if (i >= 0) { m.price = i; used.add(i); } }
  return { mapping: m, sure: m.name !== undefined && m.price !== undefined };
}

export function categoryOf(text: string, name: string): string {
  const s = `${text} ${name}`.toLowerCase();
  // Bars and lounges
  if (/hookah|shisha|hubbly|molasses|\bcoals?\b/.test(s)) return "Hookah";
  if (/\b(spirits?|whisk(e)?y|vodka|gin|rum|tequila|brandy|cognac|liqueur|bourbon|scotch|j[äa]ger(meister)?|amarula|jameson|smirnoff|klipdrift|olmeca|tots?|shots?)\b/.test(s)) return "Spirits";
  if (!/ginger ale/.test(s) && /\b(beers?|lager|ciders?|castle|black label|heineken|corona|savanna|hunter'?s|amstel|windhoek|carling|stella|ales?)\b/.test(s)) return "Beer & cider";
  if (/\b(wines?|merlot|shiraz|sauvignon|chardonnay|pinotage|champagne|bubbly|ros[ée])\b/.test(s)) return "Wine";
  if (!/infused|thc|cbd|cannabis|pipe|bong/.test(s) && /\b(coke|coca.?cola|fanta|sprite|tonic|soda|red ?bull|monster|water|juice|mixers?|lemonade|soft drinks?|ginger ale)\b/.test(s)) return "Soft drinks & mixers";
  if (/pre.?roll|joint|cone/.test(s)) return "Pre-rolls";
  if (/edible|gumm|cookie|brownie|choc|lolli|jelly|jellies|cake|candy|sweet|tea|drink/.test(s)) return "Edibles";
  if (/vape|cart|pen|disposable|rosin|hash|resin|wax|shatter|oil|extract|concentrate|dab|kief/.test(s)) return "Vapes & extracts";
  if (/paper|lighter|grinder|bong|pipe|tray|accessor|tip|filter|rolling|merch|apparel/.test(s)) return "Accessories";
  if (/flower|bud|strain|indoor|outdoor|greenhouse|kush|haze|og|gelato|runtz|cheese|skunk|sativa|indica|hybrid/.test(s)) return "Flower";
  const t = text.trim();
  return t ? t.slice(0, 40) : "Other";
}

// ml: spirits kept in ml and sold by the tot; price is then stored per ml.
export interface NewProduct { name: string; sku: string; pos_code: string | null; category: string; weight: boolean; ml?: boolean; price: string; low: string | null }

const skuFrom = (name: string, taken: Set<string>) => {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "ITEM";
  let s = base, n = 2;
  while (taken.has(s)) s = `${base}-${n++}`;
  taken.add(s);
  return s;
};

// Rows -> products. Weighed items are priced per gram ("per kg" prices are
// converted). Items already in the shop (same name or code) are skipped.
export function buildProducts(rows: string[][], m: Partial<Record<PField, number>>, existing: { name: string; sku: string }[]) {
  const cell = (r: string[], f: PField) => (m[f] === undefined ? "" : (r[m[f]!] ?? "").toString().trim());
  const taken = new Set(existing.map((e) => e.sku.toUpperCase()));
  const names = new Set(existing.map((e) => e.name.toLowerCase()));
  const items: NewProduct[] = [];
  const errors: string[] = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    const name = cell(r, "name");
    if (!name || /^(total|totals)$/i.test(name)) return;
    if (names.has(name.toLowerCase())) { skipped++; return; }
    const unitText = cell(r, "unit").toLowerCase();
    const category = categoryOf(cell(r, "category"), name);
    const ml = unitText ? /\b(tots?|shots?|ml|tot price)\b/.test(unitText) : category === "Spirits" && !/bottle|\bbtl\b|\d\s*(ml|l)\b|litre/i.test(name);
    const weight = !ml && (unitText ? /^(per\s*)?(g|gr|grams?|kg|kilo|weight|weighed)$|gram|weigh|\bkg\b/.test(unitText) : category === "Flower" && !/pre.?roll/i.test(name));
    let price = parseMoney(cell(r, "price"));
    if (price === null || price.isNegative()) { errors.push(`Row ${i + 1}: no price for ${name}`); return; }
    if (weight && /kg/.test(unitText)) price = price.dividedBy(1000);
    if (ml && !/per\s*ml/.test(unitText)) price = price.dividedBy(TOT_ML); // price list is per tot
    let sku = cell(r, "sku").toUpperCase().slice(0, 40);
    if (sku && taken.has(sku)) { skipped++; return; }
    if (sku) taken.add(sku); else sku = skuFrom(name, taken);
    const low = parseMoney(cell(r, "low"));
    names.add(name.toLowerCase());
    items.push({
      name: name.slice(0, 120), sku, pos_code: cell(r, "pos") || null, category, weight, ...(ml ? { ml } : {}),
      price: price.toDecimalPlaces(4).toString(), low: low && !low.isNegative() ? new Decimal(low).toString() : null,
    });
  });
  return { items, errors, skipped };
}
