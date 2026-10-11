// Plain-language labels used across screens and reports.
export const SHIFT_STATUS: Record<string, { label: string; tone: string }> = {
  opening: { label: "Opening", tone: "pending" },
  active: { label: "Open", tone: "neutral" },
  closing_submitted: { label: "Waiting for review", tone: "pending" },
  correction_requested: { label: "Recount requested", tone: "variance" },
  approved: { label: "Approved", tone: "matched" },
};

export const RECON_STATUS: Record<string, string> = {
  matched: "Tallies",
  variance: "Difference found",
  pending: "Waiting for the bank",
  missing_evidence: "Not recorded",
  not_counted: "Not counted",
};

export const EXCEPTION_TYPE: Record<string, string> = {
  stock_variance: "Stock difference found",
  cash_variance: "Cash difference found",
  settlement_variance: "Card total doesn’t match",
  sales_value_variance: "Price check",
  opening_float_variance: "Starting cash differs from last close",
  missing_evidence: "Something wasn’t recorded",
  special_mismatch: "Special offer doesn’t tally",
  went_into_minus: "Sold more than was in stock",
  low_stock: "Running low",
};

export const MOVEMENT_TYPE: Record<string, string> = {
  RECEIPT: "Delivery",
  TRANSFER_IN: "Moved in",
  TRANSFER_OUT: "Moved out",
  WASTAGE: "Thrown away",
  DAMAGE: "Damaged",
  INTERNAL_USE: "Staff use",
  ADJUSTMENT: "Correction (+/−)",
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
