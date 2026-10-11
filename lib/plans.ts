// Plans and prices shown in the app. The database (private.plan_price) holds
// the same prices and is what actually gets charged — change both together.

export type PlanId = "free" | "starter" | "business" | "multi_site";

// Launch offer: open from sign-up until 2 days after the 3-day trial ends
// (the database uses the same 5-day window).
export const LAUNCH_DISCOUNT = { pct: 20, months: 3, days: 5 };

// "3 days", "1 day", "20 hours"
export function timeLeft(until: string | null | undefined) {
  if (!until) return "";
  const h = Math.max(0, Math.floor((new Date(until).getTime() - Date.now()) / 3600_000));
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  return `${h} hour${h === 1 ? "" : "s"}`;
}
export const TRIAL_DAYS = 3;

export const PLANS: { id: PlanId; name: string; price: number; blurb: string; features: string[] }[] = [
  {
    id: "free",
    name: "Free",
    price: 0,
    blurb: "Try it in one shop",
    features: ["One shop, up to 15 products", "Shift counts and alerts in the app", "Last 7 days of shifts"],
  },
  {
    id: "starter",
    name: "Starter",
    price: 299,
    blurb: "For one shop",
    features: [
      "Unlimited products",
      "Email alert when a shift doesn’t tally",
      "Specials tallied separately",
      "Staff logins with manager sign-off",
      "90 days of history",
    ],
  },
  {
    id: "business",
    name: "Business",
    price: 699,
    blurb: "For a busy shop",
    features: [
      "Everything in Starter",
      "Monthly report: what sells and when, stock to watch, and what to do next",
      "Compare each day with a usual day",
      "Full history",
    ],
  },
  {
    id: "multi_site",
    name: "Multi-site",
    price: 1499,
    blurb: "For more than one shop",
    features: ["Everything in Business", "Several shops in one account", "One view across all shops"],
  },
];

export const planName = (id: string | null | undefined) => PLANS.find((p) => p.id === id)?.name ?? "Free";

export const LEGAL_NAME = process.env.NEXT_PUBLIC_LEGAL_NAME ?? "Norovari (Pty) Ltd t/a OnPoint";
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "";

export const cardConfigured = () =>
  Boolean(process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_MERCHANT_KEY && process.env.PAYFAST_PASSPHRASE);
