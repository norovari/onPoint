// Spirits (products kept in ml): staff put the open bottle on the scale and
// type the reading in grams. With the empty and full bottle weights and the
// bottle size, the reading becomes ml without needing a density table.
import Decimal from "decimal.js";

export const TOT_ML = 25; // standard South African tot

export type Bottle = { container_weight: string | number | null; full_weight: string | number | null; bottle_ml: string | number | null };

const pos = (v: string | number | null | undefined) => v !== null && v !== undefined && v !== "" && Number(v) > 0;

// True when the product has everything needed to weigh its bottle.
export function weighsBottle(p: Bottle & { base_unit: string }) {
  return p.base_unit === "ml" && pos(p.container_weight) && pos(p.full_weight) && pos(p.bottle_ml) && Number(p.full_weight) > Number(p.container_weight);
}

// Scale reading (g) -> ml left in the bottle, to one decimal.
export function readingToMl(reading: string | number, p: Bottle): Decimal {
  const empty = new Decimal(String(p.container_weight));
  const span = new Decimal(String(p.full_weight)).minus(empty);
  return new Decimal(String(reading)).minus(empty).times(String(p.bottle_ml)).dividedBy(span).toDecimalPlaces(1);
}

// ml -> what the scale would read, to show a saved count back as a reading.
export function mlToReading(ml: string | number, p: Bottle): number {
  const empty = Number(p.container_weight);
  const span = Number(p.full_weight) - empty;
  return Math.round((empty + (Number(ml) * span) / Number(p.bottle_ml)) * 1000) / 1000;
}

// "about 3 tots" for an amount in ml (empty under half a tot).
export function aboutTots(ml: number) {
  const n = Math.round(Math.abs(ml) / TOT_ML);
  return n >= 1 ? `about ${n} tot${n === 1 ? "" : "s"}` : "";
}
