// Loyverse POS link. OnPoint only READS: receipts (sales and refunds) for a
// shift, the list of stores, and the item list. Field names follow Loyverse's
// published API (v1.0); optional fields are handled defensively because some
// accounts and API versions include more than the published minimum.

export const LOYVERSE_API = "https://api.loyverse.com/v1.0";

type Money = { money_amount?: number };
export type LvReceipt = {
  receipt_number: string;
  receipt_type?: string; // SALE | REFUND
  created_at?: string;
  receipt_date?: string;
  cancelled_at?: string | null;
  store_id?: string;
  line_items?: {
    item_id?: string; variant_id?: string; item_name?: string; variant_name?: string | null; sku?: string | null;
    quantity?: number; price?: number; gross_total_money?: number; total_money?: number;
    total_discount?: number; line_discounts?: Money[]; line_taxes?: Money[];
  }[];
  payments?: { name?: string; type?: string; money_amount?: number }[];
};
export type LvItem = {
  id: string; item_name?: string; deleted_at?: string | null; sold_by_weight?: boolean;
  variants?: { variant_id?: string; sku?: string | null; default_price?: number | null; option1_value?: string | null }[];
};
export type LvStore = { id: string; name?: string };

const sum = (xs: Money[] | undefined) => (xs ?? []).reduce((s, x) => s + (Number(x.money_amount) || 0), 0);
const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

// Payment label for a receipt: Loyverse's type when present, else the name.
export function paymentLabel(r: LvReceipt) {
  const ps = r.payments ?? [];
  if (ps.length === 0) return "";
  if (ps.length > 1) {
    // Split payment: use the method that took the most
    const top = [...ps].sort((a, b) => (Number(b.money_amount) || 0) - (Number(a.money_amount) || 0))[0];
    return top.type === "CASH" ? "Cash" : top.name || top.type || "";
  }
  return ps[0].type === "CASH" ? "Cash" : ps[0].name || ps[0].type || "";
}

// Receipts -> the same rows a till export would have, so they go through the
// normal till import (column matching, product links, bag sizes, refunds).
export const LV_HEADER = ["Receipt number", "Date", "SKU", "Item", "Quantity", "Line total", "Discount", "VAT", "Payment type", "Type"];
export function receiptsToRows(receipts: LvReceipt[]): string[][] {
  const rows: string[][] = [LV_HEADER];
  for (const r of receipts) {
    if (r.cancelled_at) continue;
    const when = r.receipt_date || r.created_at || "";
    const pay = paymentLabel(r);
    const kind = r.receipt_type === "REFUND" ? "Refund" : "Sale";
    for (const li of r.line_items ?? []) {
      const name = [li.item_name, li.variant_name].filter(Boolean).join(" ");
      const discount = li.total_discount ?? sum(li.line_discounts);
      const total = li.total_money ?? (li.gross_total_money !== undefined ? li.gross_total_money - discount : (li.price ?? 0) * (li.quantity ?? 0) - discount);
      rows.push([
        `LV-${r.receipt_number}`, when, li.sku ?? "", name || "Item", String(li.quantity ?? 0),
        r2(total), r2(discount), r2(sum(li.line_taxes)), pay, kind,
      ]);
    }
  }
  return rows;
}

// Items -> new products for OnPoint (skipping ones the shop already has).
export function itemsToProducts(items: LvItem[], existing: { name: string; sku: string; pos_code?: string | null }[], categoryOf: (text: string, name: string) => string) {
  const have = new Set(existing.flatMap((p) => [p.name.toLowerCase(), p.sku.toLowerCase(), (p.pos_code ?? "").toLowerCase()]).filter(Boolean));
  const out: { name: string; sku: string; pos_code: string | null; category: string; weight: boolean; ml?: boolean; price: string; low: string | null }[] = [];
  let skipped = 0;
  for (const it of items) {
    if (it.deleted_at) continue;
    const variants = it.variants?.length ? it.variants : [{}];
    for (const v of variants) {
      const name = [it.item_name, variants.length > 1 ? v.option1_value : null].filter(Boolean).join(" ").trim();
      if (!name) continue;
      const sku = (v.sku || name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 40);
      if (have.has(name.toLowerCase()) || have.has(sku.toLowerCase())) { skipped++; continue; }
      if (v.default_price === null || v.default_price === undefined) continue; // variable price: owner sets it
      have.add(name.toLowerCase()); have.add(sku.toLowerCase());
      const category = categoryOf("", name);
      // Spirits sold by the tot are kept in ml, priced per ml (25 ml tot)
      const ml = category === "Spirits" && !it.sold_by_weight && !/bottle|\bbtl\b|\d\s*(ml|l)\b|litre/i.test(name);
      out.push({ name: name.slice(0, 120), sku, pos_code: v.sku || null, category, weight: !!it.sold_by_weight, ...(ml ? { ml } : {}),
        price: ml ? (Math.round((Number(v.default_price) / 25) * 10000) / 10000).toString() : r2(Number(v.default_price)), low: null });
    }
  }
  return { items: out, skipped };
}

// GET every page of a list endpoint.
export async function lvList<T>(token: string, path: string, key: string, params: Record<string, string> = {}, max = 40): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < max; page++) {
    const q = new URLSearchParams({ ...params, limit: "250", ...(cursor ? { cursor } : {}) });
    const res = await fetch(`${LOYVERSE_API}/${path}?${q}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (res.status === 401 || res.status === 403) throw new Error("auth");
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    out.push(...((body[key] as T[]) ?? []));
    cursor = (body.cursor as string | null) ?? null;
    if (!cursor) break;
  }
  return out;
}
