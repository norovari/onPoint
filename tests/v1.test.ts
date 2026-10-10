// v1 features: admin gate, plans and billing (24-hour launch discount),
// plan limits, specials tally, minus and low-stock alerts, till totals.
import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createUser } from "./helpers/db";
import { buildWorld, U, type World } from "./helpers/fixture";

let w: World;
const ADMIN = "00000000-0000-4000-c000-000000000001";
const FAKE_ADMIN = "00000000-0000-4000-c000-000000000002";
const val = async (q: PGlite, sql: string, params: unknown[] = []) => Object.values((await q.query(sql, params)).rows[0] as object)[0] as any;
const asService = <T>(fn: (q: PGlite) => Promise<T>) =>
  w.db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return fn(tx as unknown as PGlite);
  });

beforeAll(async () => {
  w = await buildWorld();
  await createUser(w.db, ADMIN, "Christine");
  await w.db.query(`update auth.users set email = 'nyorovai@gmail.com' where id = $1`, [ADMIN]);
  // Someone signing up with the same address but never confirming it
  await createUser(w.db, FAKE_ADMIN, "Impostor");
  await w.db.query(`update auth.users set email = 'NyoroVai@gmail.com', email_confirmed_at = null where id = $1`, [FAKE_ADMIN]);
});

describe("platform admin", () => {
  test("only the confirmed nyorovai@gmail.com account is admin", async () => {
    expect(await w.db.as(ADMIN, (q) => val(q, `select public.am_platform_admin()`))).toBe(true);
    expect(await w.db.as(FAKE_ADMIN, (q) => val(q, `select public.am_platform_admin()`))).toBe(false);
    expect(await w.db.as(U.ownerA, (q) => val(q, `select public.am_platform_admin()`))).toBe(false);
    await expect(w.db.as(U.ownerA, (q) => q.query(`select public.admin_overview()`))).rejects.toThrow(/Not found/);
    await expect(w.db.as(FAKE_ADMIN, (q) => q.query(`select public.admin_overview()`))).rejects.toThrow(/Not found/);
  });

  test("admin sees accounts and plans, but none of their stock or money rows", async () => {
    const list = await w.db.as(ADMIN, (q) => val(q, `select public.admin_overview()`));
    const a = list.find((x: any) => x.id === w.bizA);
    expect(a).toMatchObject({ name: "Demo Store A", owner_email: "ownerA@example.test", plan: "business", status: "trialing", team: 4 });
    await w.db.as(ADMIN, async (q) => {
      for (const t of ["products", "shifts", "stock_counts", "pos_sales_lines", "cash_events", "exceptions", "memberships"]) {
        expect((await q.query(`select 1 from ${t}`)).rows, t).toHaveLength(0);
      }
    });
  });
});

describe("plans and billing", () => {
  test("new businesses start on a 14-day Business trial", async () => {
    const p = await w.db.as(U.ownerA, (q) => val(q, `select public.business_plan($1)`, [w.bizA]));
    expect(p).toMatchObject({ plan: "business", status: "trialing", launch_discount_open: true });
  });

  test("subscribing within 24 hours: 20% off the first 3 months, then full price", async () => {
    const inv = await w.db.as(U.ownerA, (q) => val(q, `select public.billing_create_invoice($1, 'starter', 'card')`, [w.bizA]));
    expect(inv).toMatchObject({ list_amount: 299, discount_pct: 20, amount: 239.2, status: "pending" });

    // Wrong amount from the payment provider is rejected
    await expect(asService((q) => q.query(`select public.billing_record_card_payment($1, 1000, 'ZAR', 'AUTH_x', true, 'CUS_x', 'ownerA@example.test')`, [inv.reference]))).rejects.toThrow(/does not match/);
    // Staff and owners cannot call the server-only payment function
    await expect(w.db.as(U.ownerA, (q) => q.query(`select public.billing_record_card_payment($1, 23920, 'ZAR', 'AUTH_x', true, 'CUS_x', 'x')`, [inv.reference]))).rejects.toThrow(/permission denied/);

    const r = await asService((q) => val(q, `select public.billing_record_card_payment($1, 23920, 'ZAR', 'AUTH_x', true, 'CUS_x', 'ownerA@example.test')`, [inv.reference]));
    expect(r.already_paid).toBe(false);
    // Paying twice (callback and webhook both arrive) is harmless
    const again = await asService((q) => val(q, `select public.billing_record_card_payment($1, 23920, 'ZAR', 'AUTH_x', true, 'CUS_x', 'ownerA@example.test')`, [inv.reference]));
    expect(again.already_paid).toBe(true);

    const sub = (await w.db.query<any>(`select * from subscriptions where business_id = $1`, [w.bizA])).rows[0];
    expect(sub).toMatchObject({ plan: "starter", status: "active", payment_method: "card", paystack_authorization_code: "AUTH_x", discount_cycles_remaining: 2 });
    // Paid month starts after the remaining trial
    expect(new Date(sub.current_period_end).getTime()).toBeGreaterThan(Date.now() + 40 * 86400_000);

    // Renewal 2 and 3 discounted, renewal 4 at full price
    const amounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await w.db.query(`update subscriptions set current_period_end = now() - interval '1 minute', last_charge_attempt_at = null where business_id = $1`, [w.bizA]);
      const due = await asService((q) => q.query<any>(`select * from public.billing_due_renewals()`));
      const mine = due.rows.find((d) => d.business_id === w.bizA);
      amounts.push(Number(mine.amount));
      const renewal = await asService((q) => val(q, `select public.billing_start_renewal($1)`, [w.bizA]));
      await asService((q) => q.query(`select public.billing_record_card_payment($1, $2, 'ZAR', 'AUTH_x', true, 'CUS_x', null)`, [renewal.reference, Math.round(Number(renewal.amount) * 100)]));
    }
    expect(amounts).toEqual([239.2, 239.2, 299]);
  });

  test("after 24 hours the launch discount is gone", async () => {
    await w.db.query(`update businesses set created_at = now() - interval '25 hours' where id = $1`, [w.bizB]);
    const q1 = await w.db.as(U.ownerB, (q) => val(q, `select public.billing_quote($1, 'business')`, [w.bizB]));
    expect(q1).toMatchObject({ list_amount: 699, discount_pct: 0, amount: 699 });
  });

  test("EFT: owner gets an invoice; only the admin can mark it paid", async () => {
    const inv = await w.db.as(U.ownerB, (q) => val(q, `select public.billing_create_invoice($1, 'business', 'eft')`, [w.bizB]));
    expect(inv.reference).toMatch(/^OP[0-9A-F]{10}$/);
    await expect(w.db.as(U.ownerB, (q) => q.query(`select public.admin_mark_invoice_paid($1)`, [inv.id]))).rejects.toThrow(/Not found/);
    await w.db.as(ADMIN, (q) => q.query(`select public.admin_mark_invoice_paid($1)`, [inv.id]));
    const p = await w.db.as(U.ownerB, (q) => val(q, `select public.business_plan($1)`, [w.bizB]));
    expect(p).toMatchObject({ plan: "business", status: "active", payment_method: "eft" });
  });

  test("failed card renewal: 7 days' grace, then the Free plan", async () => {
    await w.db.query(`update subscriptions set current_period_end = now() - interval '1 minute', last_charge_attempt_at = null where business_id = $1`, [w.bizA]);
    const renewal = await asService((q) => val(q, `select public.billing_start_renewal($1)`, [w.bizA]));
    await asService((q) => q.query(`select public.billing_renewal_failed($1)`, [renewal.reference]));
    expect(await w.db.as(U.ownerA, (q) => val(q, `select public.business_plan($1)->>'plan'`, [w.bizA]))).toBe("starter");
    await w.db.query(`update subscriptions set past_due_since = now() - interval '8 days' where business_id = $1`, [w.bizA]);
    expect(await w.db.as(U.ownerA, (q) => val(q, `select public.business_plan($1)->>'plan'`, [w.bizA]))).toBe("free");
  });

  test("Free plan: 15 products and one shop", async () => {
    // business A is now effectively on Free (4 demo products already)
    await w.db.as(U.ownerA, async (q) => {
      for (let i = 0; i < 11; i++) {
        await q.query(`insert into products (business_id, sku, name, tracking_mode, base_unit) values ($1, $2, $2, 'unit', 'unit')`, [w.bizA, `X${i}`]);
      }
    });
    await expect(w.db.as(U.ownerA, (q) => q.query(`insert into products (business_id, sku, name, tracking_mode, base_unit) values ($1, 'X99', 'X99', 'unit', 'unit')`, [w.bizA]))).rejects.toThrow(/up to 15 products/);
    await expect(w.db.as(U.ownerA, (q) => q.query(`insert into locations (business_id, name) values ($1, 'Branch 2')`, [w.bizA]))).rejects.toThrow(/Multi-site/);
  });

  test("billing status cannot be changed from the app", async () => {
    await expect(w.db.as(U.ownerA, (q) => q.query(`update businesses set status = 'suspended' where id = $1`, [w.bizA]))).rejects.toThrow(/managed by billing/);
    const r = await w.db.as(U.ownerA, (q) => q.query(`update subscriptions set status = 'active', current_period_end = now() + interval '1 year' where business_id = $1`, [w.bizA]));
    expect(r.affectedRows ?? 0).toBe(0); // no update policy on subscriptions
  });
});

describe("specials, minus and low-stock alerts, till totals", () => {
  test("a special that gives away an extra item raises an alert; minus and low stock too", async () => {
    // Business B is on an active plan from the EFT test
    const { db } = w;
    const prods = (await db.query<{ id: string; pos_code: string }>(`select id, pos_code from products where business_id = $1`, [w.bizB])).rows;
    const P = Object.fromEntries(prods.map((p) => [p.pos_code, p.id]));
    const special = await db.as(U.ownerB, async (q) => {
      const s = await val(q, `insert into specials (business_id, name, code, deal_price, items_per_deal) values ($1, 'Any 2 bars for R40', 'BAR2', 40, 2) returning id`, [w.bizB]);
      await q.query(`insert into special_products (special_id, product_id) values ($1, $2)`, [s, P.P002]);
      await q.query(`update products set low_stock_level = 5 where id = $1`, [P.P001]);
      return s;
    });

    const shift = await db.as(U.ownerB, async (q) => {
      const id = await val(q, `select public.open_shift($1, 300)`, [w.locB]);
      for (const [p, v] of Object.entries({ P001: "6", P002: "20", P003: "1000", P004: "500" })) {
        await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'opening',$4,$5)`, [w.bizB, id, P[p], v, U.ownerB]);
      }
      await q.query(`select public.activate_shift($1)`, [id]);
      // Till export: 3 deals (deal refs D1..D3) but 7 bars went out; 8 water sold with only 6 counted
      const lines = [
        ...[1, 2, 3].flatMap((d) => [1, 2].map((n) => ({ external_ref: `D${d}-${n}`, transaction_at: new Date().toISOString(), pos_code: "P002", quantity: "1", gross_amount: "20.00", discount_amount: "0", payment_method: "cash", special_code: "BAR2", deal_ref: `D${d}` }))),
        { external_ref: "D3-3", transaction_at: new Date().toISOString(), pos_code: "P002", quantity: "1", gross_amount: "0.00", discount_amount: "0", payment_method: "cash", special_code: "BAR2", deal_ref: "D3" },
        { external_ref: "W1", transaction_at: new Date().toISOString(), pos_code: "P001", quantity: "8", gross_amount: "144.00", discount_amount: "0", payment_method: "card" },
      ];
      await q.query(`select public.import_pos_batch($1,'till.csv',$2,null,'264.00','0.00',$3)`, [id, "9".repeat(64), JSON.stringify(lines)]);
      // Till report figures and the card machine
      await q.query(`select public.record_till_totals($1, 120, 144)`, [id]);
      for (const [p, v] of Object.entries({ P001: "0", P002: "13", P003: "1000", P004: "500" })) {
        await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'closing',$4,$5)`, [w.bizB, id, P[p], v, U.ownerB]);
      }
      return id;
    });

    const recon = await db.as(U.ownerB, (q) => val(q, `select public.submit_closing($1, 420, '{}'::jsonb, null, 140)`, [shift]));
    const sp = recon.specials[0];
    expect(sp).toMatchObject({ name: "Any 2 bars for R40", deals: 3, units: 7, should_units: 6, extra: 1 });
    expect(Number(sp.taken)).toBe(120);
    expect(Number(sp.discount)).toBe(30); // 6 bars at R25 = R150, taken R120
    expect(Number(sp.extra_value)).toBe(25);
    expect(sp.mix[0]).toMatchObject({ name: "Granola bar", qty: 7 });

    // Cash uses the till report (R120), not the line payment data
    expect(recon.cash.source).toBe("till_report");
    expect(Number(recon.cash.expected)).toBe(420);
    // Card machine R140 vs till card R144
    const card = recon.settlements.find((x: any) => x.method === "card");
    expect(Number(card.variance)).toBe(-4);

    const water = recon.stock.find((x: any) => x.sku === "DEMO-001");
    expect(water.went_into_minus).toBe(true);
    expect(water.low_next).toBe(true);

    const made = recon.made.find((m: any) => m.name === "Granola bar");
    expect(Number(made.special_amount)).toBe(120);

    const ex = (await db.query<{ exception_type: string }>(`select exception_type::text from exceptions where shift_id = $1 and status = 'open' order by 1`, [shift])).rows.map((r) => r.exception_type);
    expect(ex).toEqual(expect.arrayContaining(["special_mismatch", "went_into_minus", "low_stock", "settlement_variance"]));
    expect(ex).not.toContain("cash_variance");
  });

  test("specials rung up by hand count deals and share the money across items", async () => {
    const { db } = w;
    const special = await db.as(U.ownerA, async (q) => {
      const sp = await val(q, `insert into specials (business_id, name, deal_price, items_per_deal) values ($1, 'Water 2 for R30', 30, 2) returning id`, [w.bizA]);
      await q.query(`insert into special_products (special_id, product_id) values ($1, $2)`, [sp, w.product.P001]);
      return sp;
    });
    const shift = await db.as(U.staffA, async (q) => {
      const id = await val(q, `select public.open_shift($1, 0)`, [w.locA]);
      const all = (await q.query<{ id: string }>(`select id from products where business_id = $1 and active`, [w.bizA])).rows;
      for (const p of all) {
        await q.query(`insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, submitted_by) values ($1,$2,$3,'opening',10,$4)`, [w.bizA, id, p.id, U.staffA]);
      }
      await q.query(`select public.activate_shift($1)`, [id]);
      // Staff ring up 4 deals by hand: 8 waters went out
      const r = await val(q, `select public.record_special_sale($1, $2, 4, $3)`, [id, special, JSON.stringify([{ product_id: w.product.P001, qty: 8 }])]);
      expect(r).toMatchObject({ deals: 4, items: 8, taken: 120 });
      return id;
    });
    // Another business's special cannot be used
    const otherSpecial = await val(db, `select id from specials where business_id = $1`, [w.bizB]);
    await expect(db.as(U.staffA, (q) => q.query(`select public.record_special_sale($1, $2, 1, $3)`, [shift, otherSpecial, JSON.stringify([{ product_id: w.product.P001, qty: 2 }])]))).rejects.toThrow(/Special not found/);

    const recon = await db.as(U.managerA, (q) => val(q, `select public.shift_reconciliation($1)`, [shift]));
    expect(recon.specials[0]).toMatchObject({ deals: 4, units: 8, should_units: 8, extra: 0 });
    expect(Number(recon.specials[0].taken)).toBe(120);
    // A hand-entered special is not mistaken for a till export
    expect(Number(recon.sales.import_count)).toBe(0);
    const water = recon.stock.find((x: any) => x.sku === "DEMO-001");
    expect(Number(water.net_sold)).toBe(8);
    expect(Number(water.special_sold)).toBe(8);
  });
});
