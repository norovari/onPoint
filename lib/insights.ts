// Turns the monthly figures (public.monthly_insights) into findings and plain
// recommendations. Used by the real monthly report and the sample one, so the
// sample never shows anything the real report can't.

export interface InsightProduct {
  name: string; unit: string; qty: number; sales: number; prev_qty: number;
  low_shifts: number; out_shifts: number; on_hand: number | null;
  diff_qty: number; diff_value: number; diff_shifts: number;
}
export interface Insights {
  days: number;
  shifts_closed: number;
  sales_total: number;
  prev_sales_total: number;
  card_share: number;
  by_dow: { dow: number; sales: number }[];
  by_hour: { hour: number; sales: number }[];
  products: InsightProduct[];
  specials: { name: string; deals: number; revenue: number }[];
  diff_by_dow: { dow: number; value: number }[];
  cash_short_total: number;
  cash_short_shifts: number;
}

export const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const zar = (n: number) => `R${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;
export const qtyText = (q: number, unit: string) => {
  const n = Math.round(q * 10) / 10;
  return unit === "g" || unit === "ml" ? `${n}${unit}` : `${n}`;
};
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// Normalise numbers that arrive from Postgres as strings
export function normalise(raw: unknown): Insights {
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => Number(v ?? 0);
  return {
    days: n(r.days), shifts_closed: n(r.shifts_closed), sales_total: n(r.sales_total),
    prev_sales_total: n(r.prev_sales_total), card_share: n(r.card_share),
    by_dow: ((r.by_dow as { dow: unknown; sales: unknown }[]) ?? []).map((d) => ({ dow: n(d.dow), sales: n(d.sales) })),
    by_hour: ((r.by_hour as { hour: unknown; sales: unknown }[]) ?? []).map((d) => ({ hour: n(d.hour), sales: n(d.sales) })),
    products: ((r.products as Record<string, unknown>[]) ?? []).map((p) => ({
      name: String(p.name), unit: String(p.unit), qty: n(p.qty), sales: n(p.sales), prev_qty: n(p.prev_qty),
      low_shifts: n(p.low_shifts), out_shifts: n(p.out_shifts), on_hand: p.on_hand === null || p.on_hand === undefined ? null : n(p.on_hand),
      diff_qty: n(p.diff_qty), diff_value: n(p.diff_value), diff_shifts: n(p.diff_shifts),
    })),
    specials: ((r.specials as Record<string, unknown>[]) ?? []).map((s) => ({ name: String(s.name), deals: n(s.deals), revenue: n(s.revenue) })),
    diff_by_dow: ((r.diff_by_dow as { dow: unknown; value: unknown }[]) ?? []).map((d) => ({ dow: n(d.dow), value: n(d.value) })),
    cash_short_total: n(r.cash_short_total), cash_short_shifts: n(r.cash_short_shifts),
  };
}

export interface Analysis {
  salesChangePct: number | null;
  perShift: number;
  best: (InsightProduct & { share: number })[];
  rising: (InsightProduct & { change: number })[];
  falling: (InsightProduct & { change: number })[];
  busiestDays: { dow: number; sales: number; share: number }[];
  quietestDay: { dow: number; sales: number } | null;
  peak: { from: number; to: number; share: number } | null;
  runningLow: InsightProduct[];
  slow: (InsightProduct & { cover: number })[];
  differences: InsightProduct[];
  differencesTotal: number;
  diffDays: { dow: number; share: number }[];
  weightShare: number; // share of differences on products sold by weight
  recommendations: { area: string; text: string }[];
}

export function analyse(d: Insights): Analysis {
  const total = d.sales_total || 0;
  const salesChangePct = d.prev_sales_total > 0 ? Math.round(((total - d.prev_sales_total) / d.prev_sales_total) * 100) : null;
  const perShift = d.shifts_closed ? total / d.shifts_closed : 0;
  const sold = d.products.filter((p) => p.sales > 0);
  const best = [...sold].sort((a, b) => b.sales - a.sales).slice(0, 5).map((p) => ({ ...p, share: total ? p.sales / total : 0 }));

  const changes = sold.filter((p) => p.prev_qty > 0 && (p.qty >= 5 || p.prev_qty >= 5)).map((p) => ({ ...p, change: Math.round(((p.qty - p.prev_qty) / p.prev_qty) * 100) }));
  const rising = changes.filter((p) => p.change >= 25).sort((a, b) => b.change - a.change).slice(0, 3);
  const falling = changes.filter((p) => p.change <= -25).sort((a, b) => a.change - b.change).slice(0, 3);

  const days = [...d.by_dow].filter((x) => x.sales > 0).sort((a, b) => b.sales - a.sales);
  const busiestDays = days.slice(0, 2).map((x) => ({ ...x, share: total ? x.sales / total : 0 }));
  const quietestDay = days.length > 2 ? days.at(-1)! : null;

  let peak: Analysis["peak"] = null;
  const hours = new Map(d.by_hour.map((h) => [h.hour, h.sales]));
  for (let h = 0; h <= 21; h++) {
    const s = (hours.get(h) ?? 0) + (hours.get(h + 1) ?? 0) + (hours.get(h + 2) ?? 0);
    if (s > 0 && (!peak || s > peak.share)) peak = { from: h, to: h + 3, share: s };
  }
  if (peak) peak.share = total ? peak.share / total : 0;

  const runningLow = d.products.filter((p) => p.out_shifts > 0 || (d.shifts_closed && p.low_shifts / d.shifts_closed >= 0.1))
    .sort((a, b) => b.sales - a.sales).slice(0, 4);
  const slow = d.products
    .filter((p) => p.on_hand && p.on_hand > 0)
    .map((p) => ({ ...p, cover: p.qty > 0 ? p.on_hand! / (p.qty / d.days) : Infinity }))
    .filter((p) => p.cover > 30)
    .sort((a, b) => b.cover - a.cover).slice(0, 3);

  const differences = d.products.filter((p) => p.diff_value > 0).sort((a, b) => b.diff_value - a.diff_value).slice(0, 5);
  const differencesTotal = d.products.reduce((a, p) => a + p.diff_value, 0);
  const diffDays = differencesTotal > 0
    ? [...d.diff_by_dow].filter((x) => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 2).map((x) => ({ dow: x.dow, share: x.value / differencesTotal }))
    : [];
  const weightShare = differencesTotal > 0
    ? d.products.filter((p) => p.unit === "g" || p.unit === "ml").reduce((a, p) => a + p.diff_value, 0) / differencesTotal : 0;

  // Recommendations, most useful first
  const rec: { area: string; text: string }[] = [];
  const topNames = new Set(best.slice(0, 3).map((p) => p.name));
  const before = busiestDays[0] ? ` before ${DAY[busiestDays[0].dow]}` : "";
  for (const p of runningLow.slice(0, 2)) {
    rec.push({
      area: "Stock",
      text: p.out_shifts > 0
        ? `${p.name} ran out on ${p.out_shifts} shift${p.out_shifts === 1 ? "" : "s"}${topNames.has(p.name) ? ", and it's one of your best sellers" : ""}. Those are sales you missed. Order more${before} and raise its low-stock level so you get warned earlier.`
        : `${p.name} ran low on ${p.low_shifts} of ${d.shifts_closed} shifts. Order a little more${before} so you don't run out.`,
    });
  }
  const grow = rising.find((p) => !runningLow.some((r) => r.name === p.name));
  if (grow) rec.push({ area: "Sales", text: `${grow.name} is selling ${grow.change}% more than the month before. Customers are asking for it: keep enough in stock and consider adding a similar product.` });
  if (busiestDays.length === 2 && busiestDays[0].share + busiestDays[1].share >= 0.3) {
    const share = Math.round((busiestDays[0].share + busiestDays[1].share) * 100);
    rec.push({ area: "Staffing", text: `${DAY[busiestDays[0].dow]} and ${DAY[busiestDays[1].dow]} bring in ${share}% of your sales${peak ? `, busiest between ${hh(peak.from)} and ${hh(peak.to)}` : ""}. Have full stock and your most experienced staff on then.` });
  }
  if (differences.length) {
    const top = differences[0];
    const onBusyDays = diffDays.length > 0 && diffDays.reduce((x, y) => x + y.share, 0) >= 0.5
      ? ` Most of it happened on ${list(diffDays.map((x) => DAY[x.dow]))}, so a quick mid-shift count of your top sellers on those days helps.` : "";
    rec.push({
      area: "Handover",
      text: (weightShare >= 0.6
        ? `Most of this month's stock differences (${zar(differencesTotal)} in total) are on products sold by the gram. Small weighing differences add up: check the scale every week and weigh ${top.name} at every handover.`
        : `${top.name} came up short on ${top.diff_shifts} shift${top.diff_shifts === 1 ? "" : "s"} (${zar(top.diff_value)}). Count it at every handover and keep it where only staff can reach it.`) + onBusyDays,
    });
  }
  if (d.cash_short_shifts > 0) {
    rec.push({ area: "Cash", text: `Cash came up short on ${d.cash_short_shifts} shift${d.cash_short_shifts === 1 ? "" : "s"} (${zar(d.cash_short_total)} in total). Count the float with two people at handover and record any cash paid out straight away.` });
  }
  if (slow.length) {
    const names = slow.slice(0, 2).map((p) => p.name);
    rec.push({ area: "Stock", text: `${list(names)} ${names.length === 1 ? "is" : "are"} moving slowly (${slow.slice(0, 2).map((p) => Number.isFinite(p.cover) ? `${Math.round(p.cover)} days` : "months").join(" and ")} of stock at the current pace). Order less next time, or put ${names.length === 1 ? "it" : "them"} on a special to free up cash.` });
  }
  if (d.specials.length) {
    const s = [...d.specials].sort((x, y) => y.revenue - x.revenue)[0];
    rec.push({ area: "Specials", text: `${s.name} was your biggest deal (${s.deals} sold, ${zar(s.revenue)}). Run it on quieter days${quietestDay ? ` like ${DAY[quietestDay.dow]}` : ""} to bring customers in.` });
  }

  return { salesChangePct, perShift, best, rising, falling, busiestDays, quietestDay, peak, runningLow, slow, differences, differencesTotal, diffDays, weightShare, recommendations: rec.slice(0, 7) };
}
