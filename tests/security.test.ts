// Phase 1 acceptance test: two businesses cannot see or touch each other's data,
// and least-privilege rules hold inside a business.
import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { buildWorld, exampleLines, EXAMPLE_TOTALS, U, type World } from "./helpers/fixture";

let w: World;
let shiftA: string;

const rows = async (q: PGlite, sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows;
const TABLES = [
  "businesses", "locations", "products", "product_prices", "shifts", "stock_counts", "stock_movements",
  "cash_events", "pos_imports", "pos_sales_lines", "settlement_records", "payment_reconciliations",
  "handover_checklists", "approvals", "exceptions", "audit_events", "subscriptions", "memberships",
];

beforeAll(async () => {
  w = await buildWorld();
  // Give business A a fully worked, submitted shift
  shiftA = (await w.db.as(U.staffA, async (q) => {
    const id = (await q.query<{ open_shift: string }>(`select public.open_shift($1, 500)`, [w.locA])).rows[0].open_shift;
    for (const p of ["P001", "P002", "P003", "P004"]) {
      await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'opening',10,$4)`, [w.bizA, id, w.product[p], U.staffA]);
    }
    await q.query(`select public.activate_shift($1)`, [id]);
    return id;
  }));
  await w.db.as(U.managerA, (q) => q.query(`select public.import_pos_batch($1,'f.csv',$2,null,$3,$4,$5)`,
    [shiftA, "e".repeat(64), EXAMPLE_TOTALS.sales, EXAMPLE_TOTALS.refunds, JSON.stringify(exampleLines())]));
  await w.db.as(U.staffA, async (q) => {
    for (const p of ["P001", "P002", "P003", "P004"]) {
      await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'closing',5,$4)`, [w.bizA, shiftA, w.product[p], U.staffA]);
    }
    await q.query(`select public.submit_closing($1, 100, '{}'::jsonb, null)`, [shiftA]);
  });
});

describe("tenant isolation", () => {
  test("owner B sees none of business A's rows in any table", async () => {
    await w.db.as(U.ownerB, async (q) => {
      for (const t of TABLES) {
        const col = t === "product_prices" ? null : "business_id";
        const leaked = col
          ? await rows(q, `select 1 from ${t} where ${t === "businesses" ? "id" : col} = $1`, [w.bizA])
          : await rows(q, `select 1 from product_prices pp join products p on p.id = pp.product_id where p.business_id = $1`, [w.bizA]);
        expect(leaked, `leak in ${t}`).toHaveLength(0);
      }
    });
  });

  test("owner B cannot open shifts, read reconciliations or insert into business A", async () => {
    await expect(w.db.as(U.ownerB, (q) => q.query(`select public.open_shift($1, 0)`, [w.locA]))).rejects.toThrow(/Location not found/);
    await expect(w.db.as(U.ownerB, (q) => q.query(`select public.shift_reconciliation($1)`, [shiftA]))).rejects.toThrow(/Shift not found/);
    await expect(w.db.as(U.ownerB, (q) => q.query(`select public.review_shift($1, 'approved', null)`, [shiftA]))).rejects.toThrow(/Shift not found/);
    await expect(w.db.as(U.ownerB, (q) => q.query(
      `insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'opening',1,$4)`,
      [w.bizA, shiftA, w.product.P001, U.ownerB]))).rejects.toThrow(/row-level security/);
    await expect(w.db.as(U.ownerB, (q) => q.query(
      `insert into products (business_id, sku, name, tracking_mode, base_unit) values ($1,'X','X','unit','unit')`, [w.bizA]))).rejects.toThrow(/row-level security/);
    // Regression: permission helpers must return false (not NULL) for non-members
    await expect(w.db.as(U.ownerB, (q) => q.query(`select public.add_member($1, 'ownerB@example.test', 'owner')`, [w.bizA]))).rejects.toThrow(/Only the owner/);
    await expect(w.db.as(U.ownerB, (q) => q.query(`select public.load_demo_catalogue($1)`, [w.bizA]))).rejects.toThrow(/Only the owner/);
    await expect(w.db.as(U.ownerB, (q) => q.query(`select public.deactivate_member($1, $2)`, [w.bizA, U.staffA]))).rejects.toThrow(/Only the owner/);
  });

  test("a staff member cannot write a row into another business by spoofing business_id", async () => {
    const shiftB = await w.db.as(U.ownerB, async (q) => (await q.query<{ open_shift: string }>(`select public.open_shift($1, 0)`, [w.locB])).rows[0].open_shift);
    await expect(w.db.as(U.staffA, (q) => q.query(
      `insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'opening',1,$4)`,
      [w.bizA, shiftB, w.product.P001, U.staffA]))).rejects.toThrow(/row-level security/);
  });

  test("anonymous visitors see nothing", async () => {
    await w.db.as(null, async (q) => {
      for (const t of TABLES) expect(await rows(q, `select 1 from ${t}`), t).toHaveLength(0);
    });
    await expect(w.db.as(null, (q) => q.query(`select public.open_shift($1, 0)`, [w.locA]))).rejects.toThrow(/permission denied/);
  });
});

describe("least privilege inside a business", () => {
  test("staff who did not work a shift cannot see its money, but can see stock", async () => {
    await w.db.as(U.staffA2, async (q) => {
      expect(await rows(q, `select 1 from payment_reconciliations where shift_id = $1`, [shiftA])).toHaveLength(0);
      expect(await rows(q, `select 1 from pos_sales_lines where shift_id = $1`, [shiftA])).toHaveLength(0);
      expect(await rows(q, `select 1 from exceptions where shift_id = $1 and exception_type = 'cash_variance'`, [shiftA])).toHaveLength(0);
      expect((await rows(q, `select 1 from exceptions where shift_id = $1 and exception_type = 'stock_variance'`, [shiftA])).length).toBeGreaterThan(0);
      const recon = (await q.query<{ r: any }>(`select public.shift_reconciliation($1) r`, [shiftA])).rows[0].r;
      expect(recon.money_visible).toBe(false);
      expect(recon.cash).toBeUndefined();
      expect(recon.stock.length).toBe(4);
    });
  });

  test("the staff member who closed the shift can see its money", async () => {
    await w.db.as(U.staffA, async (q) => {
      expect((await rows(q, `select 1 from payment_reconciliations where shift_id = $1`, [shiftA])).length).toBeGreaterThan(0);
    });
  });

  test("staff see only their own membership; managers see the team", async () => {
    await w.db.as(U.staffA, async (q) => expect(await rows(q, `select 1 from memberships`)).toHaveLength(1));
    await w.db.as(U.managerA, async (q) => expect(await rows(q, `select 1 from memberships`)).toHaveLength(4));
  });

  test("staff cannot change prices, products or the subscription", async () => {
    await expect(w.db.as(U.staffA, (q) => q.query(
      `insert into product_prices (product_id, unit_price, valid_from) values ($1, 1, now())`, [w.product.P001]))).rejects.toThrow(/row-level security/);
    await w.db.as(U.staffA, async (q) => {
      const r = await q.query(`update products set name = 'hacked' where business_id = $1`, [w.bizA]);
      expect(r.affectedRows ?? 0).toBe(0);
      expect(await rows(q, `select 1 from subscriptions`)).toHaveLength(0);
    });
  });

  test("audit trail is visible to managers, not staff", async () => {
    await w.db.as(U.staffA, async (q) => expect(await rows(q, `select 1 from audit_events`)).toHaveLength(0));
    await w.db.as(U.managerA, async (q) => expect((await rows(q, `select 1 from audit_events`)).length).toBeGreaterThan(0));
  });

  test("a deactivated leaver loses access immediately but their history stays", async () => {
    await w.db.as(U.ownerA, (q) => q.query(`select public.deactivate_member($1, $2)`, [w.bizA, U.staffA]));
    await w.db.as(U.staffA, async (q) => {
      expect(await rows(q, `select 1 from shifts`)).toHaveLength(0);
      expect(await rows(q, `select 1 from products`)).toHaveLength(0);
    });
    expect((await rows(w.db, `select 1 from stock_counts where submitted_by = $1`, [U.staffA])).length).toBe(8);
  });
});
