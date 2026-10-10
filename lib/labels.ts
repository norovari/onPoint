// Plain-language labels used across screens and reports.
export const SHIFT_STATUS: Record<string, { label: string; tone: string }> = {
  opening: { label: "Opening count", tone: "pending" },
  active: { label: "Open", tone: "neutral" },
  closing_submitted: { label: "Waiting for review", tone: "pending" },
  correction_requested: { label: "Returned for correction", tone: "variance" },
  approved: { label: "Approved", tone: "matched" },
};

export const RECON_STATUS: Record<string, string> = {
  matched: "Matched",
  variance: "Variance — review",
  pending: "Awaiting settlement",
  missing_evidence: "Missing evidence",
};

export const EXCEPTION_TYPE: Record<string, string> = {
  stock_variance: "Stock doesn’t tally",
  cash_variance: "Cash doesn’t tally",
  settlement_variance: "Card machine doesn’t tally",
  sales_value_variance: "Price check",
  opening_float_variance: "Opening cash differs from last close",
  missing_evidence: "Something is missing from the records",
  special_mismatch: "A special doesn’t tally",
  went_into_minus: "Went into minus",
  low_stock: "Running low",
};

export const MOVEMENT_TYPE: Record<string, string> = {
  RECEIPT: "Delivery received",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
  WASTAGE: "Wastage",
  DAMAGE: "Damaged",
  INTERNAL_USE: "Internal use",
  ADJUSTMENT: "Adjustment (+/−)",
};

export const CASH_EVENT: Record<string, string> = {
  PAID_IN: "Paid in",
  PAID_OUT: "Paid out (petty cash)",
  REMOVED: "Removed to safe",
  BANKED: "Banked",
};

export function when(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
