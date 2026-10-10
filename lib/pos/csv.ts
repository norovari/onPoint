// OnPoint standard POS CSV import.
//
// Expected header (one row per sale line):
//   transaction_id,line_no,timestamp,pos_code,quantity,gross_amount,discount_amount,tax_amount,payment_method,line_type
//
//  * quantity is in the product's base unit (units, or grams for weighed items)
//  * gross_amount is tax-inclusive, before discount
//  * line_type is sale | refund | void
//  * refunds carry negative quantity and negative gross_amount
//
// When the pilot store's POS is known, add an adapter that converts its export
// into this shape — the rest of the pipeline stays the same.
import Papa from "papaparse";
import Decimal from "decimal.js";

export const REQUIRED_COLUMNS = [
  "transaction_id",
  "line_no",
  "timestamp",
  "pos_code",
  "quantity",
  "gross_amount",
  "discount_amount",
  "tax_amount",
  "payment_method",
  "line_type",
] as const;

const METHODS = ["cash", "card", "eft", "other"] as const;
const DECIMAL = /^-?\d+(\.\d+)?$/;

export interface ParsedLine {
  external_ref: string;
  transaction_at: string;
  pos_code: string;
  quantity: string;
  gross_amount: string;
  discount_amount: string;
  tax_amount: string;
  payment_method: (typeof METHODS)[number];
  is_refund: boolean;
  is_void: boolean;
}

export interface ParseResult {
  lines: ParsedLine[];
  errors: string[];
  totals: { sales: string; refunds: string };
  sha256: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function parsePosCsv(text: string): Promise<ParseResult> {
  const errors: string[] = [];
  const parsed = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  for (const e of parsed.errors) errors.push(`Row ${(e.row ?? 0) + 2}: ${e.message}`);
  const headers = parsed.meta.fields ?? [];
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) {
    return { lines: [], errors: [`Missing column(s): ${missing.join(", ")}`], totals: { sales: "0", refunds: "0" }, sha256: await sha256Hex(text) };
  }

  const seen = new Set<string>();
  const lines: ParsedLine[] = [];
  let sales = new Decimal(0);
  let refunds = new Decimal(0);

  parsed.data.forEach((raw, i) => {
    const row = i + 2; // header is row 1
    const r = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, (v ?? "").trim()]));
    const rowErrors: string[] = [];

    for (const c of ["quantity", "gross_amount", "discount_amount", "tax_amount"] as const) {
      if (!DECIMAL.test(r[c] || "0")) rowErrors.push(`${c} "${r[c]}" is not a number`);
    }
    if (!r.transaction_id || !r.line_no) rowErrors.push("transaction_id and line_no are required");
    if (!r.pos_code) rowErrors.push("pos_code is required");
    const ts = new Date(r.timestamp);
    if (!r.timestamp || Number.isNaN(ts.getTime())) rowErrors.push(`timestamp "${r.timestamp}" is not a valid date/time`);
    const method = r.payment_method.toLowerCase();
    if (!METHODS.includes(method as never)) rowErrors.push(`payment_method "${r.payment_method}" must be one of ${METHODS.join(", ")}`);
    const type = r.line_type.toLowerCase();
    if (!["sale", "refund", "void"].includes(type)) rowErrors.push(`line_type "${r.line_type}" must be sale, refund or void`);

    const externalRef = `${r.transaction_id}-${r.line_no}`;
    if (seen.has(externalRef)) rowErrors.push(`duplicate line ${externalRef} in file`);
    seen.add(externalRef);

    if (rowErrors.length === 0) {
      const qty = new Decimal(r.quantity);
      const gross = new Decimal(r.gross_amount);
      const discount = new Decimal(r.discount_amount || "0");
      if (discount.isNegative()) rowErrors.push("discount_amount cannot be negative");
      if (type === "sale" && (qty.lte(0) || gross.lt(0))) rowErrors.push("sale lines need a positive quantity and amount");
      if (type === "refund" && (qty.gte(0) || gross.gt(0))) rowErrors.push("refund lines need a negative quantity and amount");

      if (rowErrors.length === 0) {
        if (type === "sale") sales = sales.plus(gross.minus(discount));
        if (type === "refund") refunds = refunds.minus(gross);
        lines.push({
          external_ref: externalRef,
          transaction_at: ts.toISOString(),
          pos_code: r.pos_code,
          quantity: qty.toString(),
          gross_amount: gross.toFixed(2),
          discount_amount: discount.toFixed(2),
          tax_amount: new Decimal(r.tax_amount || "0").toFixed(2),
          payment_method: method as ParsedLine["payment_method"],
          is_refund: type === "refund",
          is_void: type === "void",
        });
      }
    }
    for (const e of rowErrors) errors.push(`Row ${row}: ${e}`);
  });

  if (lines.length === 0 && errors.length === 0) errors.push("The file contains no sales lines");

  return {
    lines,
    errors,
    totals: { sales: sales.toFixed(2), refunds: refunds.toFixed(2) },
    sha256: await sha256Hex(text),
  };
}
