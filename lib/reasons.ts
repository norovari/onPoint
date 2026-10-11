// Common reasons a shift doesn't tally, for explaining alerts quickly.
// "Other" (or no reason) needs a note.
export const ALERT_REASONS = [
  "Counting mistake",
  "Scale or weighing difference",
  "Spillage or damage",
  "Staff sample",
  "Customer return",
  "Delivery not recorded",
  "Special offer not recorded",
  "Cash paid out not recorded",
  "Still checking",
  "Other",
] as const;
