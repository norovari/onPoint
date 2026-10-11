import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createDb, createUser, type Db } from "./helpers/db";

// End-of-shift statements: only the server writes them; staff see their own,
// managers see everyone's; nobody can change one afterwards.
const OWNER = "00000000-0000-4000-a100-000000000001";
const ANNA = "00000000-0000-4000-a100-000000000002";
const BEN = "00000000-0000-4000-a100-000000000003";
const val = async (q: PGlite, sql: string, p: unknown[] = []) => Object.values((await q.query(sql, p)).rows[0] as object)[0] as any;
let db: Db, biz: string, shift: string;

beforeAll(async () => {
  db = await createDb();
  for (const [id, n] of [[OWNER, "Owner"], [ANNA, "Anna"], [BEN, "Ben"]]) await createUser(db, id, n);
  for (const [id, e] of [[OWNER, "o@st.test"], [ANNA, "a@st.test"], [BEN, "b@st.test"]]) await db.query(`update auth.users set email = $2 where id = $1`, [id, e]);
  biz = await db.as(OWNER, (q) => val(q, `select public.create_business('Statement Shop')`));
  await db.as(OWNER, (q) => q.query(`select public.add_member($1, 'a@st.test', 'staff')`, [biz]));
  await db.as(OWNER, (q) => q.query(`select public.add_member($1, 'b@st.test', 'staff')`, [biz]));
  const loc = (await db.query<{ id: string }>(`select id from locations where business_id = $1`, [biz])).rows[0].id;
  shift = await db.as(ANNA, (q) => val(q, `select public.open_shift($1, 300)`, [loc]));
  // The server (service role) records two statements
  await db.query(`insert into shift_statements (business_id, shift_id, user_id, unrung, stock_event, notes, photos) values ($1,$2,$3,false,false,'All good','{a.jpg}')`, [biz, shift, ANNA]);
  await db.query(`insert into shift_statements (business_id, shift_id, user_id, unrung, unrung_detail, stock_event) values ($1,$2,$3,true,'Gave a regular 0.5g extra',false)`, [biz, shift, BEN]);
});

describe("shift statements", () => {
  test("app users can't write statements themselves", async () => {
    await expect(db.as(BEN, (q) => q.query(`insert into shift_statements (business_id, shift_id, user_id, unrung, stock_event) values ($1,$2,$3,false,false)`, [biz, shift, BEN])))
      .rejects.toThrow();
  });

  test("staff see their own statement; the owner sees everyone's", async () => {
    expect(Number(await db.as(ANNA, (q) => val(q, `select count(*) from shift_statements where shift_id = $1`, [shift])))).toBe(1);
    expect(Number(await db.as(OWNER, (q) => val(q, `select count(*) from shift_statements where shift_id = $1`, [shift])))).toBe(2);
  });

  test("a statement can't be changed once given", async () => {
    await db.as(BEN, (q) => q.query(`update shift_statements set unrung = false where user_id = $1`, [BEN]));
    expect(await val(db, `select unrung from shift_statements where user_id = $1`, [BEN])).toBe(true);
  });

  test("a 'yes' needs an explanation", async () => {
    await expect(db.query(`insert into shift_statements (business_id, shift_id, user_id, unrung, stock_event) values ($1,$2,$3,false,true)`, [biz, shift, OWNER])).rejects.toThrow();
  });

  test("only the owner can switch statements off", async () => {
    await expect(db.as(ANNA, (q) => q.query(`select public.set_require_statement($1, false)`, [biz]))).rejects.toThrow(/Only the owner/);
    await db.as(OWNER, (q) => q.query(`select public.set_require_statement($1, false)`, [biz]));
    expect(await val(db, `select require_statement from businesses where id = $1`, [biz])).toBe(false);
  });
});
