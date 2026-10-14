// Shared lists and checks for AgriLink listings (farmers' produce for sale).
export const PROVINCES = ["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"] as const;
export const UNITS = ["kg", "crates", "bags", "boxes", "bunches", "heads", "dozen", "tonnes", "litres", "units"] as const;
export const CROPS = ["Tomatoes", "Potatoes", "Onions", "Cabbage", "Spinach", "Butternut", "Carrots", "Green peppers", "Chillies", "Green mealies", "Beetroot", "Lettuce", "Sweet potatoes", "Pumpkin", "Garlic", "Grapes", "Raisins", "Dates", "Pecan nuts", "Citrus", "Watermelons", "Lucerne", "Eggs", "Herbs"];

export type CropRow = { crop: string; qty: string; unit: string; price: string; from: string };
export type Listing = {
  farmer: string; farm: string; phone: string; province: string; town: string;
  delivery: "deliver" | "collect"; notes: string; consent: boolean; crops: CropRow[]; plan?: string;
};

export const PLANS = [
  { id: "starter", name: "Starter", price: 99, who: "One farmer", points: ["Up to 5 crops listed at a time", "Matched with buyers in your province", "WhatsApp alert when a buyer wants your crop", "Weekly price guide for your crops"] },
  { id: "grower", name: "Grower", price: 249, who: "Growing smallholder", points: ["Unlimited crops", "Buyers in neighbouring provinces too", "Featured first in our weekly list to buyers", "Standing weekly orders from regular buyers", "Your sales record: who bought, what price, paid or not"] },
  { id: "coop", name: "Co-op", price: 599, who: "Up to 15 farmers together", points: ["Harvests combined to fill bigger orders", "Shared delivery planning", "Sales reports per farmer for grants and bank loans", "One contact person for the group"] },
] as const;

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(",", ".").trim()); return Number.isFinite(n) ? n : NaN; };

// Validates a submitted listing and returns database rows, or an error message
// a farmer can act on.
export function toRows(body: Partial<Listing>, batch: string): { rows?: Record<string, unknown>[]; error?: string } {
  const farmer = clip(body.farmer, 80);
  const phone = clip(body.phone, 20);
  const province = clip(body.province, 40);
  if (farmer.length < 2) return { error: "Please enter your name." };
  if (!/^[0-9+ ()-]{9,20}$/.test(phone) || phone.replace(/\D/g, "").length < 9) return { error: "Please enter a WhatsApp number we can reach you on." };
  if (!(PROVINCES as readonly string[]).includes(province)) return { error: "Please choose your province." };
  if (body.consent !== true) return { error: "Please tick the box so we may share your produce with buyers." };
  const crops = Array.isArray(body.crops) ? body.crops.slice(0, 12) : [];
  const rows: Record<string, unknown>[] = [];
  for (const c of crops) {
    const crop = clip(c?.crop, 40);
    if (!crop && !clip(c?.qty, 20)) continue; // empty row
    const qty = num(c?.qty);
    const unit = clip(c?.unit, 12);
    if (crop.length < 2) return { error: "Please name each crop." };
    if (!(qty > 0 && qty < 1e7)) return { error: `How much ${crop} do you have? Enter a number.` };
    if (!(UNITS as readonly string[]).includes(unit)) return { error: `Choose a unit for ${crop}.` };
    const priceRaw = clip(c?.price, 20);
    const price = priceRaw ? num(priceRaw) : null;
    if (price !== null && !(price >= 0 && price < 1e6)) return { error: `The price for ${crop} should be a number in rand.` };
    const from = clip(c?.from, 10);
    rows.push({
      batch, farmer, farm: clip(body.farm, 80) || null, phone, province, town: clip(body.town, 60) || null,
      crop, qty, unit, price, available_from: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null,
      delivery: body.delivery === "deliver" ? "deliver" : "collect", notes: clip(body.notes, 300) || null, consent: true,
      plan: ["starter", "grower", "coop", "unsure"].includes(String(body.plan)) ? body.plan : null,
    });
  }
  if (!rows.length) return { error: "Add at least one crop you have for sale." };
  return { rows };
}
