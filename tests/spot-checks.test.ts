import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createDb, createUser, type Db } from "./helpers/db";

// Spot-check counting, allowances on weighed products, full counts on request.
const OWNER = "00000000-0000-4000-e000-000000000001";
const MANAGER = "00000000-0000-4000-e000-000000000002";
const val = async (q: PGlite, sql: string, p: unknown[] = []) => Object.values((await q.query(sql, p)).rows[0] as object)[0] as any;
let db: Db, biz: string, loc: string;
let P: Record<string, string>;

beforeAll(async () => {
  db = await createDb();
  await createUser(db, OWNER, "Owner");
  await createUser(db, MANAGER, "Manager");
  await db.query(`update auth.users set email = 'owner@spot.test' where id = $1`, [OWNER]);
  await db.query(`update auth.users set email = 'manager@spot.test' where id = $1`, [MANAGER]);
  biz = await db.as(OWNER, (q) => val(q, `select public.create_business('Spot Shop')`));
  await db.as(OWNER, (q) => q.query(`select public.load_demo_catalogue($1)`, [biz]));
  await db.as(OWNER, (q) => q.query(`select public.add_member($1, 'manager@spot.test', 'manager')`, [biz]));
  loc = (await db.query<{ id: string }>(`select id from locations where business_id = $1`, [biz])).rows[0].id;
  P = Object.fromEntries((await db.query<{ sku: string; id: string }>(`select sku, id from products where business_id = $1`, [biz])).rows.map((r) => [r.sku, r.id]));
  await db.as(OWNER, (q) => q.query(`update products set always_count = true, allowance_pct = 10 where id = $1`, [P["FL-GH1"]]));
});

const sale = (ref: string, grams: string, amount: string) =>
  ({ external_ref: ref, transaction_at: new Date().toISOString(), pos_code: "FL04", quantity: grams, gross_amount: amount, discount_amount: "0", payment_method: "cash" });

async function countClosing(id: string, values: Record<string, string>) {
  const list = (await db.query<{ product_id: string }>(`select product_id from shift_count_list where shift_id = $1`, [id])).rows.map((r) => r.product_id);
  await db.as(OWNER, async (q) => {
    for (const pid of list) {
      const sku = Object.keys(P).find((k) => P[k] === pid)!;
      await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'closing',$4,$5)`, [biz, id, pid, values[sku] ?? "10", OWNER]);
    }
  });
  return list;
}

describe("spot-checks", () => {
  test("can't be switched on for shops that work sales out from counts", async () => {
    await db.as(OWNER, (q) => q.query(`select public.set_sales_source($1, 'counts')`, [biz]));
    await expect(db.as(OWNER, (q) => q.query(`select public.set_count_settings($1, 'spot', 5, 7)`, [biz]))).rejects.toThrow(/need your sales from the till/);
    await db.as(OWNER, (q) => q.query(`select public.set_sales_source($1, 'till')`, [biz]));
    await db.as(OWNER, (q) => q.query(`select public.set_count_settings($1, 'spot', 5, 7)`, [biz]));
    expect((await db.query<any>(`select count_mode, spot_per_shift from businesses where id = $1`, [biz])).rows[0]).toMatchObject({ count_mode: "spot", spot_per_shift: 5 });
  });

  test("first shift: full opening count, short list at close, the rest carried as not counted; allowance absorbs a little extra", async () => {
    const id = await db.as(OWNER, async (q) => {
      const id = await val(q, `select public.open_shift($1, 300)`, [loc]);
      for (const pid of Object.values(P)) await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'opening','10',$4)`, [biz, id, pid, OWNER]);
      await q.query(`select public.activate_shift($1)`, [id]);
      await q.query(`select public.import_pos_batch($1,'till.csv',$2,null,'220.00','0.00',$3)`, [id, "a".repeat(64), JSON.stringify([sale("S1", "4", "220.00")])]);
      return id as string;
    });
    const list = await countClosing(id, { "FL-GH1": "5.7" }); // sold 4g of 10g: expected 6, 0.3g extra is within 10% of 4g
    expect(list).toHaveLength(5);
    expect(list).toContain(P["FL-GH1"]);
    const recon = await db.as(OWNER, (q) => val(q, `select public.submit_closing($1, 520, '{}'::jsonb, null)`, [id]));
    const gelato = recon.stock.find((s: any) => s.sku === "FL-GH1");
    expect(gelato).toMatchObject({ status: "matched", counted: true });
    const notCounted = recon.stock.filter((s: any) => s.status === "not_counted");
    expect(notCounted).toHaveLength(15);
    expect(notCounted.every((s: any) => s.counted === false)).toBe(true);
    const ex = (await db.query<any>(`select exception_type from exceptions where shift_id = $1 and status = 'open' and exception_type in ('stock_variance','missing_evidence')`, [id])).rows;
    expect(ex).toEqual([]);
    await db.as(MANAGER, (q) => q.query(`select public.review_shift($1, 'approved', null)`, [id]));
  });

  test("next shift: opening carried, no count needed to start; extra beyond the allowance is flagged and explained", async () => {
    const id = await db.as(OWNER, async (q) => {
      const id = await val(q, `select public.open_shift($1, 520)`, [loc]);
      await q.query(`select public.activate_shift($1)`, [id]); // nothing to count at opening
      await q.query(`select public.import_pos_batch($1,'till2.csv',$2,null,'110.00','0.00',$3)`, [id, "b".repeat(64), JSON.stringify([sale("S2", "2", "110.00")])]);
      return id as string;
    });
    const opening = await val(db, `select quantity from stock_counts where shift_id = $1 and product_id = $2 and count_type = 'opening'`, [id, P["FL-GH1"]]);
    expect(Number(opening)).toBe(5.7);
    await countClosing(id, { "FL-GH1": "3" }); // expected 3.7, 0.7g extra on 2g sold (35%)
    await db.as(OWNER, (q) => q.query(`select public.submit_closing($1, 630, '{}'::jsonb, null)`, [id]));
    const ex = (await db.query<any>(`select explanation from exceptions where shift_id = $1 and product_id = $2 and exception_type = 'stock_variance'`, [id, P["FL-GH1"]])).rows[0];
    expect(ex.explanation).toMatch(/35% more than was sold left the stock: 0.7g extra on 2.0g sold/);
  });

  test("the most valuable stock on the shelf gets checked", async () => {
    const prev = (await db.query<{ id: string }>(`select id from shifts where business_id = $1 and status = 'closing_submitted'`, [biz])).rows[0].id;
    await db.as(MANAGER, (q) => q.query(`select public.review_shift($1, 'approved', null)`, [prev]));
    const id = await db.as(OWNER, async (q) => {
      const id = await val(q, `select public.open_shift($1, 630)`, [loc]);
      await q.query(`select public.activate_shift($1)`, [id]);
      return id as string;
    });
    const reasons = (await db.query<{ reason: string; product_id: string }>(`select reason, product_id from shift_count_list where shift_id = $1`, [id])).rows;
    expect(reasons).toHaveLength(5);
    const top = (await db.query<{ product_id: string }>(
      `select c.product_id from stock_counts c join products p on p.id = c.product_id
        where c.shift_id = $1 and c.count_type = 'opening'
          and c.product_id not in (select product_id from shift_count_list where shift_id = $1 and reason <> 'High value')
        order by c.quantity * private.price_at(c.product_id, now()) desc limit 1`, [id])).rows[0];
    expect(reasons.find((r) => r.reason === "High value")?.product_id).toBe(top.product_id);
    await db.as(OWNER, async (q) => {
      for (const r of reasons) await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'closing','10',$4)`, [biz, id, r.product_id, OWNER]);
      await q.query(`select public.submit_closing($1, 630, '{}'::jsonb, null)`, [id]);
    });
  });

  test("a manager can turn a shift into a full count", async () => {
    const prev = (await db.query<{ id: string }>(`select id from shifts where business_id = $1 and status = 'closing_submitted'`, [biz])).rows[0].id;
    await db.as(MANAGER, (q) => q.query(`select public.review_shift($1, 'approved', null)`, [prev]));
    const id = await db.as(OWNER, async (q) => {
      const id = await val(q, `select public.open_shift($1, 630)`, [loc]);
      await q.query(`select public.activate_shift($1)`, [id]);
      return id as string;
    });
    await db.as(MANAGER, (q) => q.query(`select public.request_full_count($1)`, [id]));
    expect(Number(await val(db, `select count(*) from shift_count_list where shift_id = $1`, [id]))).toBe(20);
    await expect(db.as(OWNER, (q) => q.query(`select public.submit_closing($1, 630, '{}'::jsonb, null)`, [id]))).rejects.toThrow(/20 product\(s\) still need a closing count/);
  });
});
