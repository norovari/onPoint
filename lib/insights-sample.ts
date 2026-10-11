import type { Insights } from "@/lib/insights";

// Example month for a busy dispensary. Prices match the demo shift.
const p = (name: string, unit: string, qty: number, price: number, prev_qty: number, on_hand: number,
  extra: Partial<{ low_shifts: number; out_shifts: number; diff_qty: number; diff_shifts: number }> = {}) => ({
  name, unit, qty, sales: qty * price, prev_qty, on_hand,
  low_shifts: extra.low_shifts ?? 0, out_shifts: extra.out_shifts ?? 0,
  diff_qty: extra.diff_qty ?? 0, diff_value: (extra.diff_qty ?? 0) * price, diff_shifts: extra.diff_shifts ?? 0,
});

export const SAMPLE_INSIGHTS: Insights = {
  days: 30,
  shifts_closed: 58,
  sales_total: 278560,
  prev_sales_total: 256300,
  card_share: 0.46,
  by_dow: [
    { dow: 0, sales: 30000 }, { dow: 1, sales: 28000 }, { dow: 2, sales: 29000 }, { dow: 3, sales: 33000 },
    { dow: 4, sales: 38000 }, { dow: 5, sales: 58000 }, { dow: 6, sales: 62560 },
  ],
  by_hour: [
    [9, 8000], [10, 12000], [11, 15000], [12, 20000], [13, 19000], [14, 18000], [15, 22000],
    [16, 30000], [17, 36000], [18, 38000], [19, 30000], [20, 20560], [21, 10000],
  ].map(([hour, sales]) => ({ hour, sales })),
  products: [
    p("Indoor A flower", "g", 1100, 80, 980, 160, { low_shifts: 3, diff_qty: 12.5, diff_shifts: 5 }),
    p("Outdoor flower", "g", 2400, 25, 2550, 300),
    p("Indoor AAA flower", "g", 260, 120, 180, 12, { low_shifts: 9, out_shifts: 2, diff_qty: 14, diff_shifts: 6 }),
    p("Greenhouse flower", "g", 520, 50, 540, 90, { diff_qty: 9, diff_shifts: 3 }),
    p("1ml vape cartridge", "unit", 62, 300, 48, 12),
    p("Indoor pre-roll: OG Kush", "unit", 150, 100, 140, 10, { diff_qty: 6, diff_shifts: 4 }),
    p("Indoor pre-roll: Blue Dream", "unit", 120, 100, 115, 14),
    p("Gummies 10 pack", "unit", 70, 130, 72, 15, { diff_qty: 2, diff_shifts: 2 }),
    p("Greenhouse pre-roll: Gelato", "unit", 160, 50, 150, 20),
    p("Brownie", "unit", 38, 120, 55, 10),
    p("Rosin 1g", "unit", 6, 600, 9, 14),
    p("Indoor pre-roll: Lemon Haze", "unit", 25, 100, 40, 30),
  ],
  specials: [
    { name: "Greenhouse pre-rolls, 2 for R90", deals: 61, revenue: 5490 },
    { name: "Indoor pre-rolls, 2 for R180", deals: 48, revenue: 8640 },
  ],
  diff_by_dow: [
    { dow: 0, value: 300 }, { dow: 1, value: 200 }, { dow: 2, value: 250 }, { dow: 3, value: 240 },
    { dow: 4, value: 300 }, { dow: 5, value: 1200 }, { dow: 6, value: 1500 },
  ],
  cash_short_total: 1240,
  cash_short_shifts: 5,
};
