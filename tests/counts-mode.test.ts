import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createDb, createUser, type Db } from "./helpers/db";

// A shop with no till file: sales are worked out from the counts at close.
const OWNER = "00000000-0000-4000-d000-000000000001";
const STAFF = "00000000-0000-4000-d000-000000000002";
const MANAGER = "00000000-0000-4000-d000-000000000003";
const val = async (q: PGlite, sql: string, p: unknown[] = []) => Object.values((await q.query(sql, p)).rows[0] as object)[0] as any;
let db: Db;
let biz: string;
let loc: string;
let P: Record<string, string>;

beforeAll(async () => {
  db = await createDb();
  await createUser(db, OWNER, "Owner");
  await createUser(db, STAFF, "Staff");
  await createUser(db, MANAGER, "Manager");
  await db.query(`update auth.users set email = 'manager@counts.test' where id = $1`, [MANAGER]);
  await db.query(`update auth.users set email = 'owner@counts.test' where id = $1`, [OWNER]);
  await db.query(`update auth.users set email = 'staff@counts.test' where id = $1`, [STAFF]);
  biz = await db.as(OWNER, (q) => val(q, `select public.create_business('No Till Shop')`));
  await db.as(OWNER, (q) => q.query(`select public.load_demo_catalogue($1)`, [biz]));
  await db.as(OWNER, (q) => q.query(`select public.add_member($1, 'staff@counts.test', 'staff')`, [biz]));
  await db.as(OWNER, (q) => q.query(`select public.add_member($1, 'manager@counts.test', 'manager')`, [biz]));
  loc = (await db.query<{ id: string }>(`select id from locations where business_id = $1`, [biz])).rows[0].id;
  P = Object.fromEntries((await db.query<{ sku: string; id: string }>(`select sku, id from products where business_id = $1`, [biz])).rows.map((r) => [r.sku, r.id]));
});

async function shift(opening: Record<string, string>, closing: Record<string, string>) {
  return db.as(OWNER, async (q) => {
    const id = await val(q, `select public.open_shift($1, 300)`, [loc]);
    for (const [sku, pid] of Object.entries(P)) {
      await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'opening',$4,$5)`, [biz, id, pid, opening[sku] ?? "10", OWNER]);
    }
    await q.query(`select public.activate_shift($1)`, [id]);
    for (const [sku, pid] of Object.entries(P)) {
      await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'closing',$4,$5)`, [biz, id, pid, closing[sku] ?? opening[sku] ?? "10", OWNER]);
    }
    return id as string;
  });
}

describe("no till file", () => {
  test("only the owner switches it on, and layouts save for managers", async () => {
    await expect(db.as(STAFF, (q) => q.query(`select public.set_sales_source($1, 'counts')`, [biz]))).rejects.toThrow(/Only the owner/);
    await db.as(OWNER, (q) => q.query(`select public.set_sales_source($1, 'counts')`, [biz]));
    await db.as(OWNER, (q) => q.query(`select public.set_pos_layout($1, $2)`, [biz, JSON.stringify({ columns: { qty: "Qty" }, links: { runtz: P["FL-AAA"] } })]));
    const b = (await db.query<any>(`select sales_source, pos_layout from businesses where id = $1`, [biz])).rows[0];
    expect(b.sales_source).toBe("counts");
    expect(b.pos_layout.columns.qty).toBe("Qty");
    await expect(db.as(STAFF, (q) => q.query(`select public.set_pos_layout($1, '{}')`, [biz]))).rejects.toThrow(/managers and owners/);
  });

  test("stock that left the shelf is priced and compared with the money taken", async () => {
    // 10g Gelato (R55/g) and 2 greenhouse pre-rolls (R50) left the shelf: R650.
    const id = await shift({ "FL-GH1": "50", "PR-GH1": "20" }, { "FL-GH1": "40", "PR-GH1": "18" });
    // Card machine R200, cash counted R700 against a R300 float: R50 short.
    const recon = await db.as(OWNER, (q) => val(q, `select public.submit_closing($1, 700, '{}'::jsonb, null, 200)`, [id]));
    expect(recon.stock.every((s: any) => s.status === "matched")).toBe(true);
    expect(Number(recon.cash.expected)).toBe(750);
    expect(Number(recon.cash.variance)).toBe(-50);
    const made = Object.fromEntries(recon.made.map((m: any) => [m.name, Number(m.total_amount)]));
    expect(made["Greenhouse flower: Gelato"]).toBe(550);
    expect(made["Greenhouse pre-roll: Gelato"]).toBe(100);
    const ex = (await db.query<any>(`select exception_type, explanation from exceptions where shift_id = $1 and status = 'open'`, [id])).rows;
    expect(ex.map((e) => e.exception_type)).toContain("cash_variance");
    expect(ex.find((e) => e.exception_type === "cash_variance").explanation).toMatch(/value of the stock/);
    expect(ex.map((e) => e.exception_type)).not.toContain("missing_evidence"); // no "no till file" alert
    expect(ex.map((e) => e.exception_type)).not.toContain("stock_variance");
  });

  test("a resubmitted close replaces the earlier calculation", async () => {
    const id = (await db.query<{ id: string }>(`select id from shifts where business_id = $1 order by opened_at desc limit 1`, [biz])).rows[0].id;
    await db.as(MANAGER, (q) => q.query(`select public.review_shift($1, 'returned', 'Recount the Gelato')`, [id]));
    await db.as(OWNER, (q) => q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, version, reason, submitted_by) values ($1,$2,$3,'closing','41',2,'Recount',$4)`, [biz, id, P["FL-GH1"], OWNER]));
    const recon = await db.as(OWNER, (q) => val(q, `select public.submit_closing($1, 695, '{}'::jsonb, null, 200)`, [id]));
    // Now 9g Gelato: R495 + R100 = R595; cash expected 300 + 395 = 695
    expect(Number(recon.cash.expected)).toBe(695);
    expect(recon.cash.status).toBe("matched");
    const live = (await db.query<any>(`select count(*)::int n from pos_sales_lines where shift_id = $1 and not is_void`, [id])).rows[0].n;
    expect(live).toBe(2);
  });
});
