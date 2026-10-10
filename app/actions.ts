"use server";

// Server actions. Each runs as the signed-in user; the database functions and
// RLS policies decide what is allowed. Nothing here uses a service-role key.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Decimal from "decimal.js";
import { createClient, requireSession } from "@/lib/supabase/server";
import type { ParsedLine } from "@/lib/pos/csv";

export type ActionState = { error?: string; ok?: string } | undefined;

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const DEC = /^\d+(\.\d+)?$/;
const money = (v: string) => (DEC.test(v) ? new Decimal(v).toDecimalPlaces(2).toString() : null);
const friendly = (e: { message?: string } | null) =>
  e?.message?.replace(/^.*?ERROR:\s*/, "") ?? "Something went wrong. Try again.";

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
export async function createBusiness(_: ActionState, f: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const name = str(f, "name");
  const location = str(f, "location");
  const float = money(str(f, "float") || "0");
  if (!name || !location) return { error: "Enter the business name and the shop location." };
  if (float === null) return { error: "Enter the standard till float as a number, for example 500." };

  if (str(f, "full_name")) {
    const { data } = await supabase.auth.getUser();
    if (data.user) await supabase.from("profiles").update({ full_name: str(f, "full_name") }).eq("id", data.user.id);
  }
  const { data: biz, error } = await supabase.rpc("create_business", {
    p_name: name,
    p_location_name: location,
    p_standard_float: float,
  });
  if (error) return { error: friendly(error) };
  if (f.get("demo") === "on") await supabase.rpc("load_demo_catalogue", { p_business: biz });
  redirect("/");
}

// ---------------------------------------------------------------------------
// Shift lifecycle
// ---------------------------------------------------------------------------
export async function openShift(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const float = money(str(f, "float"));
  if (float === null) return { error: "Count the float in the till and enter it, for example 500." };
  const { data, error } = await supabase.rpc("open_shift", { p_location: str(f, "location"), p_opening_float: float });
  if (error) return { error: friendly(error) };
  redirect(`/shifts/${data}`);
}

export async function saveCounts(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, userId, businessId } = await requireSession();
  const shiftId = str(f, "shift_id");
  const countType = str(f, "count_type") as "opening" | "closing";
  const reason = str(f, "reason");

  const entries: { product_id: string; quantity: string }[] = [];
  for (const [k, v] of f.entries()) {
    if (!k.startsWith("qty:")) continue;
    const q = String(v).trim();
    if (q === "") continue;
    if (!DEC.test(q)) return { error: `"${q}" is not a valid count. Use numbers only, like 12 or 2.5.` };
    entries.push({ product_id: k.slice(4), quantity: q });
  }
  if (entries.length === 0) return { error: "Enter at least one count." };

  const { data: existing } = await supabase
    .from("stock_counts")
    .select("product_id, version, quantity")
    .eq("shift_id", shiftId)
    .eq("count_type", countType);
  const latest = new Map<string, { version: number; quantity: string }>();
  for (const c of existing ?? []) {
    const cur = latest.get(c.product_id);
    if (!cur || cur.version < c.version) latest.set(c.product_id, { version: c.version, quantity: String(c.quantity) });
  }

  const rows = [];
  for (const e of entries) {
    const prev = latest.get(e.product_id);
    if (prev && new Decimal(prev.quantity).equals(e.quantity)) continue; // unchanged
    if (prev && !reason) return { error: "Some counts were already submitted. Add a reason for the recount." };
    rows.push({
      business_id: businessId,
      shift_id: shiftId,
      product_id: e.product_id,
      count_type: countType,
      quantity: e.quantity,
      version: (prev?.version ?? 0) + 1,
      reason: prev ? reason : null,
      submitted_by: userId,
    });
  }
  if (rows.length === 0) return { ok: "No changes to save." };
  const { error } = await supabase.from("stock_counts").insert(rows);
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: `Saved ${rows.length} count${rows.length === 1 ? "" : "s"}.` };
}

export async function activateShift(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const shiftId = str(f, "shift_id");
  const { error } = await supabase.rpc("activate_shift", { p_shift: shiftId });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: "Opening recorded. The shift is now active." };
}

export async function recordMovement(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, userId, businessId } = await requireSession();
  const shiftId = str(f, "shift_id");
  const type = str(f, "movement_type");
  const raw = str(f, "quantity");
  const reason = str(f, "reason");
  if (!/^-?\d+(\.\d+)?$/.test(raw) || Number(raw) === 0) return { error: "Enter a quantity, for example 12 or 2.5." };
  if (type !== "ADJUSTMENT" && raw.startsWith("-")) return { error: "Quantities are positive. The movement type sets the direction." };
  if (!reason) return { error: "Add a reason, for example the delivery note number." };
  const { error } = await supabase.from("stock_movements").insert({
    business_id: businessId,
    shift_id: shiftId,
    product_id: str(f, "product_id"),
    movement_type: type,
    quantity: raw,
    reason,
    reference: str(f, "reference") || null,
    created_by: userId,
  });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: "Movement recorded." };
}

export async function recordCashEvent(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, userId, businessId } = await requireSession();
  const shiftId = str(f, "shift_id");
  const amount = money(str(f, "amount"));
  if (amount === null || Number(amount) <= 0) return { error: "Enter an amount greater than zero." };
  if (!str(f, "reason")) return { error: "Add a reason." };
  const { error } = await supabase.from("cash_events").insert({
    business_id: businessId,
    shift_id: shiftId,
    event_type: str(f, "event_type"),
    amount,
    reason: str(f, "reason"),
    reference: str(f, "reference") || null,
    created_by: userId,
  });
  if (error) return { error: error.message.includes("row-level") ? "Only managers can record cash movements." : friendly(error) };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: "Cash movement recorded." };
}

export async function recordSettlement(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, userId, businessId } = await requireSession();
  const shiftId = str(f, "shift_id");
  const vals = Object.fromEntries(["gross", "fees", "refunds"].map((k) => [k, money(str(f, k) || "0")]));
  const adjRaw = str(f, "adjustments") || "0";
  if (Object.values(vals).some((v) => v === null) || !/^-?\d+(\.\d+)?$/.test(adjRaw)) {
    return { error: "Enter the settlement amounts as numbers." };
  }
  const adj = new Decimal(adjRaw).toDecimalPlaces(2);
  const net = new Decimal(vals.gross!).minus(vals.fees!).minus(vals.refunds!).plus(adj);
  if (!str(f, "provider") || !str(f, "reference")) return { error: "Enter the provider and the settlement reference from the statement." };

  const { data: shift } = await supabase.from("shifts").select("location_id").eq("id", shiftId).single();
  const { error } = await supabase.from("settlement_records").insert({
    business_id: businessId,
    location_id: shift?.location_id,
    shift_id: shiftId,
    payment_method: str(f, "payment_method"),
    provider: str(f, "provider"),
    provider_reference: str(f, "reference"),
    settlement_date: str(f, "settlement_date"),
    gross_amount: vals.gross,
    fees: vals.fees,
    refunds: vals.refunds,
    adjustments: adj.toString(),
    net_amount: net.toFixed(2),
    created_by: userId,
  });
  if (error) {
    if (error.message.includes("duplicate")) return { error: "That settlement reference is already recorded." };
    return { error: error.message.includes("row-level") ? "Only managers can record settlements." : friendly(error) };
  }
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: `Settlement recorded. Net ${net.toFixed(2)}.` };
}

// POS lines are parsed and validated in the browser (lib/pos/csv.ts), then
// re-validated in the database, which also checks file totals and duplicates.
export async function importPos(input: {
  shiftId: string;
  fileName: string;
  sha256: string;
  totals: { sales: string; refunds: string };
  lines: ParsedLine[];
}): Promise<ActionState> {
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("import_pos_batch", {
    p_shift: input.shiftId,
    p_file_name: input.fileName,
    p_file_sha256: input.sha256,
    p_storage_path: null,
    p_pos_total_sales: input.totals.sales,
    p_pos_total_refunds: input.totals.refunds,
    p_lines: input.lines,
  });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${input.shiftId}`);
  const r = data as { inserted: number; duplicates_skipped: number; unmapped: number };
  const parts = [`Imported ${r.inserted} line${r.inserted === 1 ? "" : "s"}`];
  if (r.duplicates_skipped) parts.push(`skipped ${r.duplicates_skipped} already imported`);
  if (r.unmapped) parts.push(`${r.unmapped} not matched to a product`);
  return { ok: parts.join(", ") + "." };
}

export async function submitClosing(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const shiftId = str(f, "shift_id");
  const cash = money(str(f, "counted_cash"));
  if (cash === null) return { error: "Count the cash in the till and enter the total." };
  const checklist = Object.fromEntries(
    ["till_closed", "fridges_ok", "keys_returned", "deliveries_filed"].map((k) => [k, f.get(k) === "on"]),
  );
  const { error } = await supabase.rpc("submit_closing", {
    p_shift: shiftId,
    p_counted_cash: cash,
    p_checklist: checklist,
    p_notes: str(f, "notes") || null,
  });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: "Shift submitted for manager review." };
}

export async function reviewShift(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const shiftId = str(f, "shift_id");
  const decision = str(f, "decision");
  const { error } = await supabase.rpc("review_shift", { p_shift: shiftId, p_decision: decision, p_notes: str(f, "notes") || null });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: decision === "approved" ? "Shift approved and locked." : "Shift returned for correction." };
}

export async function approveMovement(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("approve_movement", { p_movement: str(f, "movement_id") });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${str(f, "shift_id")}`);
  return { ok: "Movement approved." };
}

export async function updateException(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("update_exception", {
    p_exception: str(f, "exception_id"),
    p_status: str(f, "status"),
    p_explanation: str(f, "explanation"),
  });
  if (error) return { error: friendly(error) };
  revalidatePath("/exceptions");
  return { ok: str(f, "status") === "resolved" ? "Resolved." : "Explanation saved." };
}

// ---------------------------------------------------------------------------
// Settings (owner)
// ---------------------------------------------------------------------------
export async function addProduct(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, businessId, userId } = await requireSession();
  const mode = str(f, "tracking_mode");
  const price = str(f, "price");
  if (!str(f, "sku") || !str(f, "name")) return { error: "Enter a SKU and a product name." };
  if (!DEC.test(price)) return { error: "Enter the selling price, for example 18.00." };
  const base = mode === "weight" ? "g" : "unit";
  // Weighed products are priced per kg on screen, stored per gram.
  const unitPrice = mode === "weight" ? new Decimal(price).dividedBy(1000).toDecimalPlaces(4).toString() : price;
  const { data, error } = await supabase
    .from("products")
    .insert({
      business_id: businessId,
      sku: str(f, "sku"),
      name: str(f, "name"),
      tracking_mode: mode,
      base_unit: base,
      display_unit: mode === "weight" ? "kg" : "unit",
      pos_code: str(f, "pos_code") || null,
    })
    .select("id")
    .single();
  if (error) {
    if (error.message.includes("duplicate")) return { error: "That SKU or POS code is already used." };
    return { error: error.message.includes("row-level") ? "Only the owner can change products." : friendly(error) };
  }
  await supabase.from("product_prices").insert({ product_id: data.id, unit_price: unitPrice, valid_from: new Date().toISOString(), created_by: userId });
  revalidatePath("/settings");
  return { ok: "Product added." };
}

export async function addMember(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, businessId } = await requireSession();
  const { error } = await supabase.rpc("add_member", { p_business: businessId, p_email: str(f, "email"), p_role: str(f, "role"), p_location_ids: null });
  if (error) return { error: friendly(error) };
  revalidatePath("/settings");
  return { ok: "Team member added." };
}

export async function deactivateMember(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, businessId } = await requireSession();
  const { error } = await supabase.rpc("deactivate_member", { p_business: businessId, p_user: str(f, "user_id") });
  if (error) return { error: friendly(error) };
  revalidatePath("/settings");
  return { ok: "Access removed. Their history is kept." };
}

export async function updateTolerances(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, businessId } = await requireSession();
  const cash = money(str(f, "cash_tolerance"));
  const pct = str(f, "stock_tolerance_pct");
  if (cash === null || !DEC.test(pct)) return { error: "Enter tolerances as numbers." };
  const { data, error } = await supabase
    .from("businesses")
    .update({ cash_tolerance: cash, stock_tolerance_pct: pct })
    .eq("id", businessId)
    .select("id");
  if (error) return { error: friendly(error) };
  if (!data?.length) return { error: "Only the owner can change tolerances." };
  revalidatePath("/settings");
  return { ok: "Tolerances saved. They apply to shifts submitted from now on." };
}
