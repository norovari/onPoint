import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createDb, createUser, type Db } from "./helpers/db";

// Sharing the closing count at random between the people on site.
const OWNER = "00000000-0000-4000-f000-000000000001";
const ANNA = "00000000-0000-4000-f000-000000000002";
const BEN = "00000000-0000-4000-f000-000000000003";
const val = async (q: PGlite, sql: string, p: unknown[] = []) => Object.values((await q.query(sql, p)).rows[0] as object)[0] as any;
let db: Db, biz: string, loc: string, shift: string;

beforeAll(async () => {
  db = await createDb();
  for (const [id, n] of [[OWNER, "Owner"], [ANNA, "Anna"], [BEN, "Ben"]]) await createUser(db, id, n);
  for (const [id, e] of [[OWNER, "o@share.test"], [ANNA, "a@share.test"], [BEN, "b@share.test"]]) await db.query(`update auth.users set email = $2 where id = $1`, [id, e]);
  biz = await db.as(OWNER, (q) => val(q, `select public.create_business('Share Shop')`));
  await db.as(OWNER, (q) => q.query(`select public.load_demo_catalogue($1)`, [biz]));
  await db.as(OWNER, (q) => q.query(`select public.add_member($1, 'a@share.test', 'staff')`, [biz]));
  await db.as(OWNER, (q) => q.query(`select public.add_member($1, 'b@share.test', 'staff')`, [biz]));
  loc = (await db.query<{ id: string }>(`select id from locations where business_id = $1`, [biz])).rows[0].id;
  const products = (await db.query<{ id: string }>(`select id from products where business_id = $1`, [biz])).rows;
  shift = await db.as(ANNA, async (q) => {
    const id = await val(q, `select public.open_shift($1, 300)`, [loc]);
    for (const p of products) await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'opening','10',$4)`, [biz, id, p.id, ANNA]);
    await q.query(`select public.activate_shift($1)`, [id]);
    return id as string;
  });
});

const mine = async (user: string) =>
  (await db.query<{ product_id: string }>(`select product_id from shift_count_list where shift_id = $1 and assigned_to = $2`, [shift, user])).rows.map((r) => r.product_id);

describe("shared counts", () => {
  test("the person running the shift shares the full count between two people", async () => {
    await db.as(ANNA, (q) => q.query(`select public.set_counters($1, $2)`, [shift, [ANNA, BEN]]));
    const a = await mine(ANNA), b = await mine(BEN);
    expect(a.length + b.length).toBe(20);
    expect(a.length).toBe(10);
    expect(a.filter((x) => b.includes(x))).toEqual([]);
  });

  test("you can't count someone else's items, and your counts stay yours when it's re-shared", async () => {
    const b = await mine(BEN);
    await expect(db.as(ANNA, (q) => q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'closing','9',$4)`, [biz, shift, b[0], ANNA])))
      .rejects.toThrow(/someone else's count list/);
    await db.as(BEN, (q) => q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'closing','9',$4)`, [biz, shift, b[0], BEN]));
    await db.as(OWNER, (q) => q.query(`select public.join_count($1)`, [shift])); // a third person joins
    expect(await mine(BEN)).toContain(b[0]);
    const progress = await db.as(ANNA, (q) => val(q, `select public.count_progress($1)`, [shift]));
    expect(progress.map((p: any) => p.name)).toEqual(["Anna", "Ben", "Owner"]);
    expect(progress.reduce((s: number, p: any) => s + p.assigned, 0)).toBe(20);
    expect(progress.find((p: any) => p.name === "Ben").counted).toBe(1);
  });

  test("only the person running the shift or a manager chooses who counts", async () => {
    await expect(db.as(BEN, (q) => q.query(`select public.set_counters($1, $2)`, [shift, [BEN]]))).rejects.toThrow(/running the shift or a manager/);
  });
});

describe("changing who counts", () => {
  test("taking someone off the count hands their open items to the others", async () => {
    await db.as(ANNA, (q) => q.query(`select public.set_counters($1, $2)`, [shift, [ANNA, BEN]]));
    const progress = await db.as(ANNA, (q) => val(q, `select public.count_progress($1)`, [shift]));
    expect(progress.map((p: any) => p.name).sort()).toEqual(["Anna", "Ben"]);
    expect(progress.reduce((s: number, p: any) => s + p.assigned, 0)).toBe(20);
  });
});
