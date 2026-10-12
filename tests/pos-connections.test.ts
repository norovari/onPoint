import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createDb, createUser, type Db } from "./helpers/db";

const OWNER = "00000000-0000-4000-b200-000000000001";
const OTHER = "00000000-0000-4000-b200-000000000002";
const val = async (q: PGlite, sql: string, p: unknown[] = []) => Object.values((await q.query(sql, p)).rows[0] as object)[0] as any;
let db: Db, biz: string;

beforeAll(async () => {
  db = await createDb();
  await createUser(db, OWNER, "Owner");
  await createUser(db, OTHER, "Other");
  biz = await db.as(OWNER, (q) => val(q, `select public.create_business('POS Shop')`));
  await db.query(`insert into pos_connections (business_id, token, store_id, store_name) values ($1, 'secret-key', 's1', 'Main')`, [biz]);
});

describe("POS connections", () => {
  test("app users can never read the key", async () => {
    const rows = await db.as(OWNER, (q) => q.query(`select token from pos_connections`));
    expect(rows.rows).toEqual([]);
  });
  test("members see that a POS is connected, not the key", async () => {
    const c = await db.as(OWNER, (q) => val(q, `select public.pos_connection($1)`, [biz]));
    expect(c).toMatchObject({ provider: "loyverse", store_name: "Main" });
    expect(JSON.stringify(c)).not.toContain("secret-key");
    expect(await db.as(OTHER, (q) => val(q, `select public.pos_connection($1)`, [biz]))).toBeNull();
  });
});
