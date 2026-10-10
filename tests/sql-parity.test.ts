// The database and the TypeScript preview must agree to the cent and gram.
import { beforeAll, expect, test } from "vitest";
import Decimal from "decimal.js";
import { buildWorld, exampleLines, EXAMPLE_TOTALS, U, type World } from "./helpers/fixture";
import { reconcile } from "@/lib/calculations/reconcile";

let w: World;
let shift: string;

beforeAll(async () => {
  w = await buildWorld();
  // A second price for P001 effective only from the middle of the shift, so the
  // price-at-transaction-time lookup is exercised in both implementations.
  await w.db.query(`update product_prices set valid_to = now() - interval '270 minutes' where product_id = $1`, [w.product.P001]);
  await w.db.query(`insert into product_prices (product_id, unit_price, valid_from) values ($1, 20.00, now() - interval '270 minutes')`, [w.product.P001]);

  shift = await w.db.as(U.staffA, async (q) => {
    const id = (await q.query<{ open_shift: string }>(`select public.open_shift($1, 500)`, [w.locA])).rows[0].open_shift;
    const qty: Record<string, string> = { P001: "100", P002: "50", P003: "2500.5", P004: "1000" };
    for (const [p, v] of Object.entries(qty)) {
      await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'opening',$4,$5)`, [w.bizA, id, w.product[p], v, U.staffA]);
    }
    await q.query(`select public.activate_shift($1)`, [id]);
    await q.query(
      `insert into stock_movements (business_id, shift_id, product_id, movement_type, quantity, reason, created_by) values
       ($1,$2,$3,'RECEIPT',20,'DN',$5), ($1,$2,$3,'WASTAGE',2,'broken',$5), ($1,$2,$4,'ADJUSTMENT',-12.25,'recount',$5)`,
      [w.bizA, id, w.product.P001, w.product.P004, U.staffA]);
    return id;
  });
  await w.db.as(U.managerA, async (q) => {
    await q.query(`select public.import_pos_batch($1,'f.csv',$2,null,$3,$4,$5)`, [shift, "f".repeat(64), EXAMPLE_TOTALS.sales, EXAMPLE_TOTALS.refunds, JSON.stringify(exampleLines())]);
    await q.query(`insert into cash_events (business_id, shift_id, event_type, amount, reason, created_by) values ($1,$2,'BANKED',300,'drop',$3), ($1,$2,'PAID_OUT',12.40,'milk',$3)`, [w.bizA, shift, U.managerA]);
    await q.query(
      `insert into settlement_records (business_id, location_id, shift_id, payment_method, provider, provider_reference, settlement_date, gross_amount, fees, refunds, adjustments, net_amount, created_by)
       values ($1,$2,$3,'card','Acq','S1',current_date,268.00,6.70,0,0,261.30,$4)`, [w.bizA, w.locA, shift, U.managerA]);
  });
  await w.db.as(U.staffA, async (q) => {
    const qty: Record<string, string> = { P001: "80", P002: "51", P003: "2249.75", P004: "987.75" };
    for (const [p, v] of Object.entries(qty)) {
      await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'closing',$4,$5)`, [w.bizA, shift, w.product[p], v, U.staffA]);
    }
    await q.query(`select public.submit_closing($1, 642.37, '{}'::jsonb, null)`, [shift]);
  });
});

const eq = (a: unknown, b: unknown, label: string) => {
  if (a === null || a === undefined || b === null || b === undefined) {
    expect(a ?? null, label).toBe(b ?? null);
  } else {
    expect(new Decimal(a as Decimal.Value).equals(new Decimal(b as Decimal.Value)), `${label}: ${a} vs ${b}`).toBe(true);
  }
};

test("TypeScript preview matches the database reconciliation exactly", async () => {
  const sql = (await w.db.as(U.managerA, (q) => q.query<{ r: any }>(`select public.shift_reconciliation($1) r`, [shift]))).rows[0].r;

  const q = <T>(s: string, p: unknown[] = []) => w.db.query<T>(s, p).then((r) => r.rows);
  const biz = (await q<any>(`select * from businesses where id = $1`, [w.bizA]))[0];
  const sh = (await q<any>(`select * from shifts where id = $1`, [shift]))[0];
  const ts = reconcile({
    business: biz,
    shift: sh,
    products: await q(`select id, sku, name, tracking_mode, base_unit, active from products where business_id = $1`, [w.bizA]),
    counts: await q(`select product_id, count_type, quantity, version from stock_counts where shift_id = $1`, [shift]),
    movements: await q(`select product_id, movement_type, quantity from stock_movements where shift_id = $1`, [shift]),
    lines: await q(`select l.*, private.price_at(l.product_id, l.transaction_at) as unit_price from pos_sales_lines l where shift_id = $1`, [shift]),
    events: await q(`select event_type, amount from cash_events where shift_id = $1`, [shift]),
    settlements: await q(`select payment_method, gross_amount, refunds, fees, adjustments, net_amount from settlement_records where shift_id = $1`, [shift]),
  });

  expect(ts.stock.map((s) => s.sku)).toEqual(sql.stock.map((s: any) => s.sku));
  ts.stock.forEach((s, i) => {
    const d = sql.stock[i];
    for (const k of ["opening", "receipts", "wastage", "adjustments", "net_sold", "expected_closing", "counted_closing", "variance"] as const) {
      eq((s as any)[k], d[k], `${s.sku}.${k}`);
    }
    expect(s.status, `${s.sku}.status`).toBe(d.status);
  });

  for (const k of ["pos_gross", "pos_discounts", "pos_net", "pos_refunds", "calculated_at_list", "pos_gross_mapped", "sales_value_variance", "unmapped_lines", "unpriced_lines"]) {
    eq((ts.sales as any)[k], sql.sales[k], `sales.${k}`);
  }
  for (const k of ["opening_float", "cash_sales", "cash_refunds", "paid_out", "banked", "expected", "counted", "variance"]) {
    eq((ts.cash as any)[k], sql.cash[k], `cash.${k}`);
  }
  expect(ts.cash.status).toBe(sql.cash.status);

  expect(ts.settlements).toHaveLength(sql.settlements.length);
  ts.settlements.forEach((s, i) => {
    for (const k of ["pos_expected", "expected_net", "net", "variance"]) eq((s as any)[k], sql.settlements[i][k], `settlement.${k}`);
    expect(s.status).toBe(sql.settlements[i].status);
  });

  // Sanity on the scenario itself
  expect(sql.cash.status).toBe("variance");
  expect(sql.settlements[0].status).toBe("variance"); // settled 268 gross vs 270 in POS
  expect(Number(sql.sales.sales_value_variance)).not.toBe(0); // P001 repriced mid-shift
});
