// End-to-end shift workflow against the real migrations:
// open → count → activate → movements → POS import → cash → settlement →
// close → manager returns → recount → resubmit → approve.
import { beforeAll, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { buildWorld, exampleLines, EXAMPLE_TOTALS, U, type World } from "./helpers/fixture";

let w: World;
let shift: string;
let firstRecon: any;

const val = async (q: PGlite, sql: string, params: unknown[] = []) => Object.values((await q.query(sql, params)).rows[0] as object)[0];
const count = (q: PGlite, shiftId: string, p: string, type: string, qty: string, version = 1, reason: string | null = null, user = U.staffA) =>
  q.query(
    `insert into stock_counts (business_id, shift_id, product_id, count_type, quantity, version, reason, submitted_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [w.bizA, shiftId, w.product[p], type, qty, version, reason, user],
  );

beforeAll(async () => {
  w = await buildWorld();
});

describe("opening", () => {
  test("staff opens a shift and cannot activate until every product is counted", async () => {
    shift = (await w.db.as(U.staffA, (q) => val(q, `select public.open_shift($1, 500)`, [w.locA]))) as string;
    expect(shift).toMatch(/[0-9a-f-]{36}/);

    await w.db.as(U.staffA, async (q) => {
      await count(q, shift, "P001", "opening", "100");
      await count(q, shift, "P002", "opening", "50");
      await count(q, shift, "P003", "opening", "2500");
    });
    await expect(w.db.as(U.staffA, (q) => q.query(`select public.activate_shift($1)`, [shift]))).rejects.toThrow(/1 product\(s\) still need an opening count/);

    await w.db.as(U.staffA, async (q) => {
      await count(q, shift, "P004", "opening", "1000");
      await q.query(`select public.activate_shift($1)`, [shift]);
    });
    expect(await val(w.db, `select status from shifts where id = $1`, [shift])).toBe("active");
  });

  test("a second shift cannot be opened at the same location", async () => {
    await expect(w.db.as(U.staffA2, (q) => q.query(`select public.open_shift($1, 500)`, [w.locA]))).rejects.toThrow(/already has a shift in progress/);
  });
});

describe("during the shift", () => {
  test("staff receipts are accepted; staff wastage needs manager approval", async () => {
    await w.db.as(U.staffA, async (q) => {
      await q.query(
        `insert into stock_movements (business_id, shift_id, product_id, movement_type, quantity, reason, created_by)
         values ($1,$2,$3,'RECEIPT',20,'Delivery DN-1042',$4), ($1,$2,$3,'WASTAGE',2,'Dropped and broken',$4)`,
        [w.bizA, shift, w.product.P001, U.staffA],
      );
    });
    const rows = (await w.db.query<{ movement_type: string; requires_approval: boolean }>(
      `select movement_type, requires_approval from stock_movements where shift_id = $1 order by movement_type`, [shift])).rows;
    expect(rows).toEqual([
      { movement_type: "RECEIPT", requires_approval: false },
      { movement_type: "WASTAGE", requires_approval: true },
    ]);
  });

  test("staff cannot import POS data or record cash removals", async () => {
    await expect(
      w.db.as(U.staffA, (q) => q.query(`select public.import_pos_batch($1,'f.csv',$2,null,$3,$4,$5)`,
        [shift, "a".repeat(64), EXAMPLE_TOTALS.sales, EXAMPLE_TOTALS.refunds, JSON.stringify(exampleLines())])),
    ).rejects.toThrow(/Only managers and owners/);
    await expect(
      w.db.as(U.staffA, (q) => q.query(
        `insert into cash_events (business_id, shift_id, event_type, amount, reason, created_by) values ($1,$2,'REMOVED',100,'x',$3)`,
        [w.bizA, shift, U.staffA])),
    ).rejects.toThrow(/row-level security/);
  });

  test("POS import rejects a file whose totals disagree with its lines", async () => {
    await expect(
      w.db.as(U.managerA, (q) => q.query(`select public.import_pos_batch($1,'f.csv',$2,null,$3,$4,$5)`,
        [shift, "b".repeat(64), "999.00", EXAMPLE_TOTALS.refunds, JSON.stringify(exampleLines())])),
    ).rejects.toThrow(/File totals do not match/);
  });

  test("manager imports POS data; re-importing never double-counts", async () => {
    const r = (await w.db.as(U.managerA, (q) => val(q, `select public.import_pos_batch($1,'day.csv',$2,null,$3,$4,$5)`,
      [shift, "c".repeat(64), EXAMPLE_TOTALS.sales, EXAMPLE_TOTALS.refunds, JSON.stringify(exampleLines())]))) as any;
    expect(r).toMatchObject({ lines_in_file: 6, inserted: 6, duplicates_skipped: 0, unmapped: 1 });

    // Same file again → refused outright
    await expect(
      w.db.as(U.managerA, (q) => q.query(`select public.import_pos_batch($1,'day.csv',$2,null,$3,$4,$5)`,
        [shift, "c".repeat(64), EXAMPLE_TOTALS.sales, EXAMPLE_TOTALS.refunds, JSON.stringify(exampleLines())])),
    ).rejects.toThrow(/already been imported/);

    // A different export that overlaps the same transactions → overlapping lines skipped
    const r2 = (await w.db.as(U.managerA, (q) => val(q, `select public.import_pos_batch($1,'day-v2.csv',$2,null,$3,$4,$5)`,
      [shift, "d".repeat(64), EXAMPLE_TOTALS.sales, EXAMPLE_TOTALS.refunds, JSON.stringify(exampleLines())]))) as any;
    expect(r2).toMatchObject({ inserted: 0, duplicates_skipped: 6 });
    expect(Number(await val(w.db, `select count(*) from pos_sales_lines where shift_id = $1`, [shift]))).toBe(6);
  });

  test("manager banks cash and records the card settlement", async () => {
    await w.db.as(U.managerA, async (q) => {
      await q.query(`insert into cash_events (business_id, shift_id, event_type, amount, reason, created_by) values ($1,$2,'BANKED',300,'Mid-shift drop to safe',$3)`, [w.bizA, shift, U.managerA]);
      await q.query(
        `insert into settlement_records (business_id, location_id, shift_id, payment_method, provider, provider_reference, settlement_date, gross_amount, fees, refunds, adjustments, net_amount, created_by)
         values ($1,$2,$3,'card','DemoAcquirer','STL-0001',current_date,270.00,6.75,0,0,263.25,$4)`,
        [w.bizA, w.locA, shift, U.managerA]);
    });
  });

  test("a settlement whose net does not add up is rejected", async () => {
    await expect(w.db.as(U.managerA, (q) => q.query(
      `insert into settlement_records (business_id, location_id, shift_id, payment_method, provider, provider_reference, settlement_date, gross_amount, fees, refunds, adjustments, net_amount, created_by)
       values ($1,$2,$3,'card','DemoAcquirer','STL-BAD',current_date,100,5,0,0,99,$4)`, [w.bizA, w.locA, shift, U.managerA]))).rejects.toThrow(/check constraint/);
  });
});

describe("closing", () => {
  test("cannot submit until every product has a closing count", async () => {
    await expect(w.db.as(U.staffA, (q) => q.query(`select public.submit_closing($1, 650, '{}'::jsonb, null)`, [shift]))).rejects.toThrow(/still need a closing count/);
  });

  test("submission calculates expected stock, cash and settlements and raises exceptions", async () => {
    firstRecon = await w.db.as(U.staffA, async (q) => {
      await count(q, shift, "P001", "closing", "79");
      await count(q, shift, "P002", "closing", "51");
      await count(q, shift, "P003", "closing", "2240");
      await count(q, shift, "P004", "closing", "1000");
      return val(q, `select public.submit_closing($1, 650, $2, 'Till 1 sticky drawer')`, [shift, JSON.stringify({ fridge_ok: true, keys_returned: true })]);
    });

    const stock = Object.fromEntries(firstRecon.stock.map((s: any) => [s.sku, s]));
    // Blueprint example: 100 + 20 received − 35 sold − 2 wastage = 83; counted 79 → −4
    expect(Number(stock["DEMO-001"].expected_closing)).toBe(83);
    expect(Number(stock["DEMO-001"].variance)).toBe(-4);
    // Refund puts one unit back: 50 + 1 = 51, matched
    expect(stock["DEMO-002"].status).toBe("matched");
    // Weighed: 2500 g − 250 g = 2250 g; counted 2240 g → −10 g
    expect(Number(stock["DEMO-003"].variance)).toBe(-10);
    expect(stock["DEMO-004"].status).toBe("matched");

    // Cash: 500 float + 480 cash sales − 25 refund − 300 banked = 655; counted 650 → −5
    expect(Number(firstRecon.cash.cash_sales)).toBe(480);
    expect(Number(firstRecon.cash.cash_refunds)).toBe(25);
    expect(Number(firstRecon.cash.expected)).toBe(655);
    expect(Number(firstRecon.cash.variance)).toBe(-5);

    // Card: POS 270 − 6.75 fees = 263.25 expected; settled 263.25 → matched
    expect(firstRecon.settlements).toHaveLength(1);
    expect(firstRecon.settlements[0]).toMatchObject({ method: "card", status: "matched" });

    // Sales value: list-price value of mapped lines equals POS gross → no variance; 1 unmapped line
    expect(Number(firstRecon.sales.sales_value_variance)).toBe(0);
    expect(Number(firstRecon.sales.unmapped_lines)).toBe(1);

    const ex = (await w.db.query<{ exception_type: string }>(
      `select exception_type from exceptions where shift_id = $1 and status = 'open' order by exception_type::text`, [shift])).rows.map((r) => r.exception_type);
    expect(ex).toEqual(["cash_variance", "missing_evidence", "stock_variance", "stock_variance"]);
    expect(await val(w.db, `select status from shifts where id = $1`, [shift])).toBe("closing_submitted");
  });

  test("submitted counts are locked: staff cannot add, edit or delete them", async () => {
    await expect(w.db.as(U.staffA, (q) => count(q, shift, "P001", "closing", "83", 2, "recount"))).rejects.toThrow(/row-level security/);
    await expect(w.db.query(`update stock_counts set quantity = 83 where shift_id = $1`, [shift])).rejects.toThrow(/append-only/);
    await expect(w.db.query(`delete from stock_counts where shift_id = $1`, [shift])).rejects.toThrow(/append-only/);
  });
});

describe("manager review", () => {
  test("staff cannot review; the reviewer must give a reason to return", async () => {
    await expect(w.db.as(U.staffA, (q) => q.query(`select public.review_shift($1, 'approved', null)`, [shift]))).rejects.toThrow(/Only managers/);
    await expect(w.db.as(U.managerA, (q) => q.query(`select public.review_shift($1, 'returned', '')`, [shift]))).rejects.toThrow(/Explain what needs correcting/);
  });

  test("manager returns the shift for a recount", async () => {
    await w.db.as(U.managerA, (q) => q.query(`select public.review_shift($1, 'returned', 'Please recount sparkling water')`, [shift]));
    expect(await val(w.db, `select status from shifts where id = $1`, [shift])).toBe("correction_requested");
  });

  test("recount adds version 2 with a reason; resubmission supersedes old exceptions", async () => {
    await expect(w.db.as(U.staffA, (q) => count(q, shift, "P001", "closing", "83", 2, null))).rejects.toThrow(/check constraint/);
    await w.db.as(U.staffA, async (q) => {
      await count(q, shift, "P001", "closing", "83", 2, "Found a case in the back fridge");
      await q.query(`select public.submit_closing($1, 650, '{}'::jsonb, 'Recounted')`, [shift]);
    });
    const versions = (await w.db.query<{ quantity: string }>(
      `select quantity from stock_counts where shift_id = $1 and product_id = $2 and count_type = 'closing' order by version`, [shift, w.product.P001])).rows;
    expect(versions.map((v) => Number(v.quantity))).toEqual([79, 83]);

    const open = (await w.db.query<{ exception_type: string }>(
      `select exception_type from exceptions where shift_id = $1 and status = 'open' order by exception_type::text`, [shift])).rows.map((r) => r.exception_type);
    expect(open).toEqual(["cash_variance", "missing_evidence", "stock_variance"]); // P001 no longer varies
    expect(Number(await val(w.db, `select count(*) from exceptions where shift_id = $1 and status = 'superseded'`, [shift]))).toBe(4);
    expect(Number(await val(w.db, `select max(version) from payment_reconciliations where shift_id = $1`, [shift]))).toBe(2);
  });

  test("approval is blocked while staff wastage is unapproved; staff cannot approve it", async () => {
    await expect(w.db.as(U.managerA, (q) => q.query(`select public.review_shift($1, 'approved', null)`, [shift]))).rejects.toThrow(/still need approval/);
    const mv = await val(w.db, `select id from stock_movements where shift_id = $1 and movement_type = 'WASTAGE'`, [shift]);
    await expect(w.db.as(U.staffA, (q) => q.query(`select public.approve_movement($1)`, [mv]))).rejects.toThrow(/Only managers/);
    await w.db.as(U.managerA, (q) => q.query(`select public.approve_movement($1)`, [mv]));
  });

  test("separation of duties: someone who worked the shift cannot approve it", async () => {
    // Promote staffA to manager temporarily to prove the rule is about who worked, not role
    await w.db.as(U.ownerA, (q) => q.query(`select public.add_member($1, 'staffA@example.test', 'manager')`, [w.bizA]));
    await expect(w.db.as(U.staffA, (q) => q.query(`select public.review_shift($1, 'approved', null)`, [shift]))).rejects.toThrow(/another manager or the owner/);
    await w.db.as(U.ownerA, (q) => q.query(`select public.add_member($1, 'staffA@example.test', 'staff')`, [w.bizA]));
  });

  test("manager approves; the shift is locked and the next shift sees the history", async () => {
    await w.db.as(U.managerA, (q) => q.query(`select public.review_shift($1, 'approved', 'Cash short R5 noted')`, [shift]));
    expect(await val(w.db, `select status from shifts where id = $1`, [shift])).toBe("approved");
    await expect(w.db.query(`update shifts set status = 'active' where id = $1`, [shift])).rejects.toThrow(/workflow functions/);
    await expect(w.db.query(`delete from shifts where id = $1`, [shift])).rejects.toThrow(/cannot be deleted/);

    // Next shift: opener counts 1000 g of tea instead of the 2240 g left at close → opening exception
    const next = (await w.db.as(U.staffA2, (q) => val(q, `select public.open_shift($1, 600)`, [w.locA]))) as string;
    await w.db.as(U.staffA2, async (q) => {
      await count(q, next, "P001", "opening", "83", 1, null, U.staffA2);
      await count(q, next, "P002", "opening", "51", 1, null, U.staffA2);
      await count(q, next, "P003", "opening", "1000", 1, null, U.staffA2);
      await count(q, next, "P004", "opening", "1000", 1, null, U.staffA2);
      await q.query(`select public.activate_shift($1)`, [next]);
    });
    const ex = (await w.db.query<{ exception_type: string; difference: string }>(
      `select exception_type, difference from exceptions where shift_id = $1 order by exception_type::text`, [next])).rows;
    // Float: 600 counted vs 650 left at close; tea: 1000 vs 2240
    expect(ex.map((e) => [e.exception_type, Number(e.difference)])).toEqual([
      ["opening_float_variance", -50],
      ["stock_variance", -1240],
    ]);
  });

  test("every important action is in the audit trail", async () => {
    const actions = (await w.db.query<{ entity_type: string; n: string }>(
      `select entity_type, count(*) n from audit_events where business_id = $1 group by entity_type order by entity_type`, [w.bizA])).rows;
    const types = actions.map((a) => a.entity_type);
    for (const t of ["approvals", "cash_events", "exceptions", "handover_checklists", "pos_imports", "settlement_records", "shifts", "stock_counts", "stock_movements"]) {
      expect(types).toContain(t);
    }
    await expect(w.db.query(`delete from audit_events`)).rejects.toThrow(/append-only/);
  });
});

describe("exceptions", () => {
  test("staff can explain; only managers can resolve", async () => {
    const ex = await val(w.db, `select id from exceptions where shift_id = $1 and exception_type = 'stock_variance' and status = 'open'`, [shift]);
    await w.db.as(U.staffA, (q) => q.query(`select public.update_exception($1, 'explained', 'Scale was not tared')`, [ex]));
    await expect(w.db.as(U.staffA, (q) => q.query(`select public.update_exception($1, 'resolved', 'done')`, [ex]))).rejects.toThrow(/Only managers/);
    await w.db.as(U.managerA, (q) => q.query(`select public.update_exception($1, 'resolved', 'Scale recalibrated')`, [ex]));
    const row = (await w.db.query<{ status: string; explanation: string }>(`select status, explanation from exceptions where id = $1`, [ex])).rows[0];
    expect(row.status).toBe("resolved");
    expect(row.explanation).toContain("Scale was not tared");
    expect(row.explanation).toContain("Scale recalibrated");
  });
});

export { w, shift };
