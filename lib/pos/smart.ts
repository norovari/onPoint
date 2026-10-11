// Reads a sales export from any till: finds the heading row, works out which
// column is which from the headings, links the till's product names or codes
// to OnPoint products, and turns the rows into OnPoint sales lines.
// The owner confirms anything it isn't sure about once; the layout is saved
// per shop (businesses.pos_layout) so later files import straight away.
import Decimal from "decimal.js";
import type { ParsedLine } from "@/lib/pos/csv";

export type Field = "date" | "time" | "txn" | "code" | "name" | "qty" | "amount" | "price" | "discount" | "tax" | "payment" | "type";

export const FIELDS: { key: Field; label: string; required?: boolean }[] = [
  { key: "name", label: "Product name" },
  { key: "code", label: "Product code / SKU" },
  { key: "qty", label: "Quantity sold", required: true },
  { key: "amount", label: "Line total (R)" },
  { key: "price", label: "Unit price (R)" },
  { key: "date", label: "Date (or date and time)" },
  { key: "time", label: "Time" },
  { key: "payment", label: "Payment type (cash, card…)" },
  { key: "txn", label: "Receipt / transaction number" },
  { key: "discount", label: "Discount (R)" },
  { key: "tax", label: "VAT (R)" },
  { key: "type", label: "Sale, refund or void" },
];

export type Mapping = Partial<Record<Field, number>>; // field -> column index

export interface Layout {
  columns?: Partial<Record<Field, string>>; // field -> heading text, as last confirmed
  links?: Record<string, string>; // till item key -> OnPoint product id
  skip?: string[]; // till item keys that aren't stock (lighters, papers…)
  sizes?: Record<string, number>; // till item key -> grams in each sale ("2g bag" = 2)
}

export interface Product { id: string; name: string; sku: string; pos_code: string | null; base_unit?: string }

// "Gelato 2g", "Bag 3.5 gram" -> grams in one sale. Null when the name doesn't say.
export function sizeFromName(name: string): number | null {
  const m = /(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(?:g|gr|grams?)\b/i.exec(name);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return n > 0 && n <= 1000 ? n : null;
}

// Words that point at each field, strongest first. Headings are lower-cased and
// stripped of punctuation before matching.
const HINTS: Record<Field, RegExp[]> = {
  txn: [/^(receipt|invoice|transaction|trans|txn|sale|order|docket|slip)\s*(no|nr|number|id|#|ref)?$/, /^(?!.*(total|date|time|amount|value|type|status)).*\b(receipt|invoice|transaction|txn|order)\b/],
  code: [/^(sku|plu|barcode|item code|product code|stock code|code|item id|product id|article)$/, /^(?!.*(price|total|qty)).*\b(sku|plu|barcode|code)\b/],
  name: [/^(item|product|description|item name|product name|item description|product description|stock item|name)$/, /^(?!.*(price|code|id|total|qty|quantity|category|type|group|count|sold)).*\b(item|product|description)\b/],
  qty: [/^(qty|quantity|qty sold|quantity sold|units|units sold|count|weight|grams|g|amount sold|sold)$/, /\b(qty|quantity|units|weight|grams)\b/],
  amount: [/^(total|line total|amount|net|net total|total incl|total inc vat|value|sales|sale amount|nett|gross|revenue|incl)$/, /\b(total|amount|value|incl|revenue|sales)\b/],
  price: [/^(price|unit price|selling price|rate|each|price each|sell price)$/, /\b(price|rate|each)\b/],
  date: [/^(date|date time|datetime|timestamp|sale date|transaction date|created|created at|date sold|time stamp)$/, /\b(date|timestamp|datetime)\b/],
  time: [/^(time|sale time|transaction time)$/, /\btime\b/],
  payment: [/^(payment|payment type|payment method|tender|tender type|method|paid by|pay type|paymenttype)$/, /\b(payment|tender|paid|method)\b/],
  discount: [/^(discount|disc|discount amount|markdown|promo)$/, /\b(discount|disc)\b/],
  tax: [/^(tax|vat|vat amount|tax amount|gst)$/, /\b(tax|vat)\b/],
  type: [/^(type|line type|status|transaction type|sale type|kind)$/, /\b(type|status)\b/],
};

const norm = (h: string) => h.toLowerCase().replace(/[_\-./()#:]+/g, " ").replace(/\s+/g, " ").trim();

// The heading row is the first row (in the top 15) with at least three cells
// that look like headings we know.
export function findHeaderRow(rows: string[][]): number {
  let best = 0, bestScore = -1;
  rows.slice(0, 15).forEach((r, i) => {
    const score = r.filter((c) => c && Object.values(HINTS).some((hs) => hs.some((h) => h.test(norm(c))))).length;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

// Best guess for each field. A strong (whole-heading) match beats a word match;
// each column is used once. "sure" is false when a required field is missing.
export function guessMapping(headers: string[], saved?: Layout["columns"]): { mapping: Mapping; sure: boolean } {
  const mapping: Mapping = {};
  const used = new Set<number>();
  const H = headers.map(norm);
  // Headings the owner confirmed before win
  if (saved) {
    for (const [f, text] of Object.entries(saved) as [Field, string][]) {
      const i = H.indexOf(norm(text));
      if (i >= 0 && !used.has(i)) { mapping[f] = i; used.add(i); }
    }
  }
  for (const pass of [0, 1]) {
    for (const f of Object.keys(HINTS) as Field[]) {
      if (mapping[f] !== undefined) continue;
      const i = H.findIndex((h, j) => !used.has(j) && h && HINTS[f][pass].test(h));
      if (i >= 0) { mapping[f] = i; used.add(i); }
    }
  }
  // "time" only makes sense next to a date-only column
  const sure = mapping.qty !== undefined && (mapping.name !== undefined || mapping.code !== undefined)
    && (mapping.amount !== undefined || mapping.price !== undefined);
  return { mapping, sure };
}

// "R 1 234,50" / "1,234.50" / "(12.00)" / "-12" -> Decimal, or null
export function parseMoney(v: string): Decimal | null {
  let s = (v ?? "").toString().trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/zar|r(?=[\s\d-])|\s| /gi, "");
  if (s.endsWith("-")) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, ""); // 1,234.50
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", "."); // 1.234,50
  else if (/^\d+,\d+$/.test(s)) s = s.replace(",", "."); // 12,50
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const d = new Decimal(s);
  return neg ? d.negated() : d;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Dates as South African tills write them (day first), ISO, or Excel serials.
// Times without a zone are South African time.
export function parseDateTime(date: string, time?: string): Date | null {
  let d = (date ?? "").toString().trim();
  const t = (time ?? "").toString().trim();
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(d) && /(Z|[+-]\d{2}:?\d{2})$/.test(d)) {
    const x = new Date(d);
    return Number.isNaN(x.getTime()) ? null : x;
  }
  if (/^\d{5}(\.\d+)?$/.test(d)) { // Excel serial date
    const ms = Math.round((Number(d) - 25569) * 86400_000);
    const x = new Date(ms);
    return sast(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), x.getUTCHours(), x.getUTCMinutes(), x.getUTCSeconds());
  }
  if (t) d = `${d} ${t}`;
  let m = d.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (m) return sast(+m[1], +m[2], +m[3], ampm(+(m[4] ?? 0), m[7]), +(m[5] ?? 0), +(m[6] ?? 0));
  m = d.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (m) {
    let day = +m[1], mon = +m[2];
    if (mon > 12 && day <= 12) [day, mon] = [mon, day]; // month-first file
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return sast(y, mon, day, ampm(+(m[4] ?? 0), m[7]), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  m = d.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (m && MONTHS[m[2].toLowerCase()]) return sast(+m[3], MONTHS[m[2].toLowerCase()], +m[1], ampm(+(m[4] ?? 0), m[7]), +(m[5] ?? 0), +(m[6] ?? 0));
  return null;
}
const ampm = (h: number, s?: string) => (!s ? h : s.toLowerCase() === "pm" ? (h % 12) + 12 : h % 12);
function sast(y: number, mo: number, d: number, h: number, mi: number, s: number) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return new Date(Date.UTC(y, mo - 1, d, h - 2, mi, s));
}

export function paymentOf(v: string): ParsedLine["payment_method"] {
  const s = (v ?? "").toLowerCase();
  if (!s) return "other";
  if (/cash|kontant/.test(s)) return "cash";
  if (/card|visa|master|amex|credit|debit|yoco|ikhokha|speedpoint|tap|pos|zapper card|nfc/.test(s)) return "card";
  if (/eft|transfer|snapscan|zapper|instant|ozow|payshap|bank/.test(s)) return "eft";
  return "other";
}

const TOTAL_ROW = /^(total|totals|subtotal|sub total|grand total)$/i;

// The distinct till items in a file (blank and total rows left out)
export function collectItems(rows: string[][], mapping: Mapping) {
  const items = new Map<string, { key: string; code: string; name: string; count: number }>();
  for (const r of rows) {
    const code = mapping.code !== undefined ? (r[mapping.code] ?? "").toString().trim() : "";
    const name = mapping.name !== undefined ? (r[mapping.name] ?? "").toString().trim() : "";
    const key = itemKey(code, name);
    if (!key || TOTAL_ROW.test(name || code)) continue;
    const it = items.get(key) ?? { key, code, name, count: 0 };
    it.count++;
    items.set(key, it);
  }
  return [...items.values()];
}

// The key a till item is remembered by: its code if there is one, else its name
export function itemKey(code: string, name: string) {
  return (code || name || "").toString().trim().toLowerCase();
}

const simple = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Links each till item to a product: saved link, then code, SKU, then name.
export function linkItems(items: { key: string; code: string; name: string }[], products: Product[], layout: Layout) {
  const linked: Record<string, string> = {};
  const unmatched: { key: string; code: string; name: string }[] = [];
  const skip = new Set(layout.skip ?? []);
  for (const it of items) {
    if (skip.has(it.key)) continue;
    const saved = layout.links?.[it.key];
    const byCode = it.code && products.find((p) => (p.pos_code && p.pos_code.toLowerCase() === it.code.toLowerCase()) || p.sku.toLowerCase() === it.code.toLowerCase());
    const byName = it.name && products.find((p) => simple(p.name) === simple(it.name));
    const p = (saved && products.find((x) => x.id === saved)) || byCode || byName;
    if (p) linked[it.key] = p.id; else unmatched.push(it);
  }
  return { linked, unmatched };
}

export interface Built {
  lines: ParsedLine[];
  errors: string[];
  totals: { sales: string; refunds: string };
  hasPayment: boolean;
  byMethod: Record<string, string>;
  skipped: number;
}

// Turns rows into sales lines. Lines for skipped items are left out; lines
// for items not linked to a product keep the till code so they show as
// "not matched" rather than disappear.
export function buildLines(
  rows: string[][], mapping: Mapping, links: Record<string, string>, skip: string[],
  products: Product[], fallbackTime: Date, fileTag: string, sizes: Record<string, number> = {},
): Built {
  const errors: string[] = [];
  const lines: ParsedLine[] = [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const skipSet = new Set(skip);
  const cell = (r: string[], f: Field) => (mapping[f] === undefined ? "" : (r[mapping[f]!] ?? "").toString().trim());
  const perTxn = new Map<string, number>();
  let sales = new Decimal(0), refunds = new Decimal(0), skipped = 0;
  const byMethod: Record<string, Decimal> = {};

  rows.forEach((r, i) => {
    if (r.every((c) => !c || !c.toString().trim())) return;
    const code = cell(r, "code"), name = cell(r, "name");
    const key = itemKey(code, name);
    if (!key) return; // subtotal / blank lines
    if (TOTAL_ROW.test(name || code)) return;
    if (skipSet.has(key)) { skipped++; return; }
    const row = i + 1;
    const typeText = cell(r, "type").toLowerCase();
    const isVoid = /void|cancel|deleted/.test(typeText);
    let qty = parseMoney(cell(r, "qty").replace(/\s*(g|gr|grams?|ml|x|ea|each|pcs?|units?)$/i, ""));
    let amount = parseMoney(cell(r, "amount"));
    const price = parseMoney(cell(r, "price"));
    const discount = parseMoney(cell(r, "discount")) ?? new Decimal(0);
    const tax = parseMoney(cell(r, "tax")) ?? new Decimal(0);
    if (qty === null) { errors.push(`Row ${row}: quantity "${cell(r, "qty")}" isn't a number`); return; }
    if (amount === null && price !== null) amount = price.times(qty).toDecimalPlaces(2);
    if (amount === null) { errors.push(`Row ${row}: no amount for ${name || code}`); return; }
    const isRefund = !isVoid && (/refund|return/.test(typeText) || qty.isNegative() || amount.isNegative());
    // Refund lines: negative quantity and amount, whatever the till wrote
    if (isRefund) { qty = qty.abs().negated(); amount = amount.abs().negated(); }
    else { qty = qty.abs(); amount = amount.abs(); }
    if (qty.isZero()) return;
    const when = parseDateTime(cell(r, "date"), cell(r, "time")) ?? fallbackTime;
    const txn = cell(r, "txn");
    const n = (perTxn.get(txn) ?? 0) + 1;
    perTxn.set(txn, n);
    const product = links[key] ? byId.get(links[key]) : undefined;
    // Fixed bags: the till counts bags, stock is in grams
    const size = product ? sizes[key] : undefined;
    if (size && size > 0 && size !== 1) qty = qty.times(size);
    const method = paymentOf(cell(r, "payment"));
    // The till's amount is tax-inclusive after discount on most exports; OnPoint
    // stores gross before discount, so add any discount back.
    const disc = discount.abs();
    const gross = isRefund ? amount : amount.plus(disc);
    lines.push({
      external_ref: txn ? `${txn}-${n}` : `${fileTag}-${row}`,
      transaction_at: when.toISOString(),
      pos_code: product ? product.pos_code ?? product.sku : (code || name).slice(0, 80),
      quantity: qty.toString(),
      gross_amount: gross.toFixed(2),
      discount_amount: isRefund ? "0.00" : disc.toFixed(2),
      tax_amount: tax.abs().toFixed(2),
      payment_method: method,
      is_refund: isRefund,
      is_void: isVoid,
    });
    if (!isVoid) {
      if (isRefund) refunds = refunds.minus(gross);
      else sales = sales.plus(gross.minus(disc));
      const net = isRefund ? gross : gross.minus(disc);
      byMethod[method] = (byMethod[method] ?? new Decimal(0)).plus(net);
    }
  });
  if (!lines.length && !errors.length) errors.push("No sales lines found in this file.");
  return {
    lines, errors, skipped,
    totals: { sales: sales.toFixed(2), refunds: refunds.toFixed(2) },
    hasPayment: mapping.payment !== undefined,
    byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, v.toFixed(2)])),
  };
}

// The separator a CSV uses: comma, semicolon (common in SA), tab or pipe.
// Title lines above the table are ignored by looking at the busiest lines.
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ",", bestScore = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1).filter((n) => n >= 2);
    const score = counts.length;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

// Cells from CSV or Excel as plain strings (Excel dates become ISO text)
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // Excel stores local (SA) wall-clock time; read-excel-file returns it as UTC
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())} ${p(v.getUTCHours())}:${p(v.getUTCMinutes())}:${p(v.getUTCSeconds())}`;
  }
  return String(v);
}
