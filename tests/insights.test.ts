import { describe, expect, test } from "vitest";
import { analyse, normalise } from "@/lib/insights";
import { SAMPLE_INSIGHTS } from "@/lib/insights-sample";

describe("monthly report insights", () => {
  const a = analyse(SAMPLE_INSIGHTS);

  test("sample figures add up", () => {
    const s = SAMPLE_INSIGHTS;
    expect(s.products.reduce((x, p) => x + p.sales, 0)).toBe(s.sales_total);
    expect(s.by_dow.reduce((x, d) => x + d.sales, 0)).toBe(s.sales_total);
    expect(s.by_hour.reduce((x, d) => x + d.sales, 0)).toBe(s.sales_total);
    expect(Math.round(s.diff_by_dow.reduce((x, d) => x + d.value, 0))).toBe(Math.round(a.differencesTotal));
  });

  test("finds trends and gives recommendations", () => {
    expect(a.salesChangePct).toBe(9);
    expect(a.best[0].name).toBe("Indoor A flower");
    expect(a.rising.map((p) => p.name)).toContain("Indoor AAA flower");
    expect(a.falling.map((p) => p.name)).toContain("Brownie");
    expect(a.busiestDays.map((d) => d.dow)).toEqual([6, 5]);
    expect(a.runningLow.map((p) => p.name)).toEqual(["Indoor AAA flower"]);
    expect(a.slow.map((p) => p.name)).toEqual(["Rosin 1g", "Indoor pre-roll: Lemon Haze"]);
    const areas = a.recommendations.map((r) => r.area);
    expect(areas).toEqual(expect.arrayContaining(["Stock", "Staffing", "Handover", "Cash", "Specials"]));
    expect(a.recommendations.length).toBeLessThanOrEqual(7);
  });

  test("an empty month gives no recommendations and no errors", () => {
    const empty = analyse(normalise({ days: 30, shifts_closed: 0, sales_total: "0", prev_sales_total: 0, card_share: 0, by_dow: [], by_hour: [], products: [], specials: [], diff_by_dow: [], cash_short_total: 0, cash_short_shifts: 0 }));
    expect(empty.recommendations).toEqual([]);
    expect(empty.salesChangePct).toBeNull();
  });
});
