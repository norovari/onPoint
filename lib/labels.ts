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
  stock_variance: "Stock difference",
  cash_variance: "Cash difference",
  settlement_variance: "Settlement difference",
  sales_value_variance: "Price check",
  opening_float_variance: "Opening float difference",
  missing_evidence: "Missing evidence",
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
