// Common reasons a shift doesn't tally, for explaining alerts quickly.
// "Other" (or no reason) needs a note.
export const ALERT_REASONS = [
  "Counting mistake (recounted)",
  "Scale or weighing difference",
  "Spillage or damage",
  "Staff sample or tasting",
  "Customer return",
  "Delivery not logged",
  "Special or deal not recorded",
  "Cash paid out not recorded",
  "Not explained yet (looking into it)",
  "Other",
] as const;
