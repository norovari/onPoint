import type { PGlite } from "@electric-sql/pglite";
import { createDb, createUser, type Db } from "./db";

export const U = {
  ownerA: "00000000-0000-4000-a000-000000000001",
  managerA: "00000000-0000-4000-a000-000000000002",
  staffA: "00000000-0000-4000-a000-000000000003",
  staffA2: "00000000-0000-4000-a000-000000000004",
  ownerB: "00000000-0000-4000-b000-000000000001",
};

export interface World {
  db: Db;
  bizA: string;
  locA: string;
  bizB: string;
  locB: string;
  product: Record<string, string>; // pos_code -> id
}

const one = async <T = Record<string, unknown>>(q: PGlite, sql: string, params: unknown[] = []) =>
  (await q.query<T>(sql, params)).rows[0];

export async function buildWorld(): Promise<World> {
  const db = await createDb();
  for (const [k, id] of Object.entries(U)) {
    await createUser(db, id, k);
    await db.query(`update auth.users set email = $2 where id = $1`, [id, `${k}@example.test`]);
  }

  const bizA = await db.as(U.ownerA, async (q) => {
    const { create_business } = await one<{ create_business: string }>(q, `select public.create_business('Demo Store A', 'Main', 500)`);
    await q.query(`select public.load_demo_catalogue($1)`, [create_business]);
    await q.query(`select public.add_member($1, 'managerA@example.test', 'manager')`, [create_business]);
    await q.query(`select public.add_member($1, 'staffA@example.test', 'staff')`, [create_business]);
    await q.query(`select public.add_member($1, 'staffA2@example.test', 'staff')`, [create_business]);
    return create_business;
  });
  const bizB = await db.as(U.ownerB, async (q) => {
    const r = await one<{ create_business: string }>(q, `select public.create_business('Other Store B', 'Branch', 300)`);
    await q.query(`select public.load_demo_catalogue($1)`, [r.create_business]);
    return r.create_business;
  });

  const locA = (await one<{ id: string }>(db, `select id from locations where business_id = $1`, [bizA])).id;
  const locB = (await one<{ id: string }>(db, `select id from locations where business_id = $1`, [bizB])).id;
  const products = (await db.query<{ id: string; pos_code: string }>(`select id, pos_code from products where business_id = $1`, [bizA])).rows;
  const product = Object.fromEntries(products.map((p) => [p.pos_code, p.id]));
  return { db, bizA, locA, bizB, locB, product };
}

export const t = (h: number) => new Date(Date.now() - 3600_000 * (6 - h)).toISOString();

// The worked example used across tests (see README "Worked example").
export function exampleLines() {
  return [
    { external_ref: "T1-1", transaction_at: t(1), pos_code: "P001", quantity: "20", gross_amount: "360.00", discount_amount: "0", tax_amount: "46.96", payment_method: "cash", is_refund: false, is_void: false },
    { external_ref: "T2-1", transaction_at: t(2), pos_code: "P001", quantity: "15", gross_amount: "270.00", discount_amount: "0", tax_amount: "35.22", payment_method: "card", is_refund: false, is_void: false },
    { external_ref: "T3-1", transaction_at: t(2), pos_code: "P003", quantity: "250", gross_amount: "112.50", discount_amount: "2.50", tax_amount: "14.35", payment_method: "cash", is_refund: false, is_void: false },
    { external_ref: "T4-1", transaction_at: t(3), pos_code: "P002", quantity: "-1", gross_amount: "-25.00", discount_amount: "0", tax_amount: "-3.26", payment_method: "cash", is_refund: true, is_void: false },
    { external_ref: "T5-1", transaction_at: t(3), pos_code: "P002", quantity: "2", gross_amount: "50.00", discount_amount: "0", tax_amount: "6.52", payment_method: "cash", is_refund: false, is_void: true },
    { external_ref: "T6-1", transaction_at: t(4), pos_code: "X99", quantity: "1", gross_amount: "10.00", discount_amount: "0", tax_amount: "1.30", payment_method: "cash", is_refund: false, is_void: false },
  ];
}
export const EXAMPLE_TOTALS = { sales: "750.00", refunds: "25.00" };
