"use server";

// Server actions. Each runs as the signed-in user; the database functions and
// RLS policies decide what is allowed. Nothing here uses a service-role key.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Decimal from "decimal.js";
import { createClient, requireSession } from "@/lib/supabase/server";
import type { ParsedLine } from "@/lib/pos/csv";
import { sha256Hex } from "@/lib/pos/csv";
import { notifyAdmin, sendShiftAlert } from "@/lib/notify";
import { checkPhotos, passwordMatches, statementText, storePhotos, type StatementRow } from "@/lib/statements";
import { LOCK_MINUTES, MAX_TRIES, PIN_RE, hashPin, pinMatches } from "@/lib/pin";
import { createServiceClient } from "@/lib/supabase/service";

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

  // Tell the OnPoint admin about a brand-new shop (not a repeat of an existing one)
  const { data: b } = await supabase.from("businesses").select("created_at").eq("id", biz).maybeSingle();
  if (b && Date.now() - new Date(b.created_at).getTime() < 120_000) {
    const [{ data: who }, { data: plan }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.rpc("business_plan", { p_business: biz }),
    ]);
    const p = plan as { reference?: string; current_period_end?: string } | null;
    await notifyAdmin(`New sign-up: ${name}`, [
      `${name} just signed up for OnPoint.`,
      "",
      `Shop: ${location}`,
      `Owner: ${str(f, "full_name") || "(no name given)"}, ${who.user?.email ?? "no email"}`,
      `Reference: ${p?.reference ?? "-"}`,
      `Sample menu loaded: ${f.get("demo") === "on" ? "yes" : "no"}`,
      "3-day trial started.",
    ]);
  }
  redirect("/today");
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

  // Jars: staff weigh the whole jar, so take the empty jar off
  const { data: jars } = await supabase.from("products").select("id, name, container_weight").in("id", entries.map((e) => e.product_id)).not("container_weight", "is", null);
  for (const j of jars ?? []) {
    const e = entries.find((x) => x.product_id === j.id);
    if (!e || !(Number(j.container_weight) > 0)) continue;
    const net = new Decimal(e.quantity).minus(String(j.container_weight));
    if (net.isNegative()) return { error: `${j.name}: ${e.quantity}g is less than the empty jar (${Number(j.container_weight)}g). Weigh the jar with the stock in it.` };
    e.quantity = net.toString();
  }

  const { data: existing } = await supabase
    .from("stock_counts")
    .select("product_id, version, quantity, source")
    .eq("shift_id", shiftId)
    .eq("count_type", countType);
  const latest = new Map<string, { version: number; quantity: string; carried: boolean }>();
  for (const c of existing ?? []) {
    const cur = latest.get(c.product_id);
    if (!cur || cur.version < c.version) latest.set(c.product_id, { version: c.version, quantity: String(c.quantity), carried: c.source === "carried" });
  }

  const rows = [];
  for (const e of entries) {
    const prev = latest.get(e.product_id);
    if (prev && new Decimal(prev.quantity).equals(e.quantity)) continue; // unchanged
    if (prev && !prev.carried && !reason) return { error: "Some counts were already submitted. Add a reason for the recount." };
    rows.push({
      business_id: businessId,
      shift_id: shiftId,
      product_id: e.product_id,
      count_type: countType,
      quantity: e.quantity,
      version: (prev?.version ?? 0) + 1,
      reason: prev ? (prev.carried ? reason || "Counted (was carried forward)" : reason) : null,
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
  const { supabase, businessName, businessId, userId } = await requireSession();
  const shiftId = str(f, "shift_id");
  const cash = money(str(f, "counted_cash"));
  if (cash === null) return { error: "Count the cash in the till and enter the total." };
  const cardRaw = str(f, "card_machine_total");
  const card = cardRaw === "" ? null : money(cardRaw);
  if (cardRaw !== "" && card === null) return { error: "Enter the card machine total as a number, or leave it empty if you have no card machine." };
  const checklist = Object.fromEntries(
    ["till_closed", "fridges_ok", "keys_returned", "deliveries_filed"].map((k) => [k, f.get(k) === "on"]),
  );
  const { data: req } = await supabase.from("businesses").select("require_statement").eq("id", businessId).single();
  if (req?.require_statement) {
    const { data: mine } = await supabase.from("shift_statements").select("id").eq("shift_id", shiftId).eq("user_id", userId).maybeSingle();
    if (!mine) return { error: "Answer the shift questions first." };
  }
  const { error } = await supabase.rpc("submit_closing", {
    p_shift: shiftId,
    p_counted_cash: cash,
    p_checklist: checklist,
    p_notes: str(f, "notes") || null,
    p_card_machine_total: card,
  });
  if (error) return { error: friendly(error) };

  // Email the owner and managers if the shift doesn't tally (only when email is set up)
  const { data: open } = await supabase
    .from("exceptions")
    .select("exception_type, severity")
    .eq("shift_id", shiftId)
    .eq("status", "open")
    .neq("severity", "info");
  const { data: plan } = await supabase.rpc("business_plan", { p_business: businessId });
  let statements: string[] = [];
  try {
    const { data: st } = await createServiceClient()
      .from("shift_statements").select("user_id, unrung, unrung_detail, stock_event, stock_event_detail, notes, photos, created_at, profiles(full_name)")
      .eq("shift_id", shiftId).order("created_at");
    statements = (st ?? []).map((r) => statementText({ ...(r as unknown as StatementRow), name: (r.profiles as unknown as { full_name: string } | null)?.full_name || undefined }));
  } catch { /* email still goes without statements */ }
  if ((open?.length || statements.length) && (plan as { plan: string } | null)?.plan !== "free") {
    const { data: recipients } = await supabase.rpc("shift_alert_recipients", { p_shift: shiftId });
    await sendShiftAlert({
      to: ((recipients ?? []) as { email: string }[]).map((r) => r.email),
      businessName,
      shiftId,
      problems: open?.length ?? 0,
      statements,
    });
  }
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: "Shift submitted. Your manager can now review it." };
}

export async function recordSpecialSale(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const shiftId = str(f, "shift_id");
  const deals = Number(str(f, "deals"));
  if (!Number.isInteger(deals) || deals < 1) return { error: "Enter how many deals were sold, for example 3." };
  const mix: { product_id: string; qty: string }[] = [];
  for (const [k, v] of f.entries()) {
    if (!k.startsWith("mix:")) continue;
    const q = String(v).trim();
    if (q === "" || q === "0") continue;
    if (!DEC.test(q)) return { error: `"${q}" is not a valid quantity.` };
    mix.push({ product_id: k.slice(4), qty: q });
  }
  if (!mix.length) return { error: "Enter how many of each item went out with the deals." };
  const { data, error } = await supabase.rpc("record_special_sale", { p_shift: shiftId, p_special: str(f, "special_id"), p_deals: deals, p_mix: mix });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${shiftId}`);
  const r = data as { deals: number; items: number; taken: number };
  return { ok: `Recorded ${r.deals} deal${r.deals === 1 ? "" : "s"}, ${r.items} items out.` };
}

// For tills without an export: the manager types the till's end-of-day report.
export async function enterTillSales(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const shiftId = str(f, "shift_id");
  const cash = money(str(f, "till_cash"));
  const card = money(str(f, "till_card") || "0");
  if (cash === null || card === null) return { error: "Enter the cash and card totals from the till report." };

  const { data: products } = await supabase.from("products").select("id, sku, pos_code, product_prices(unit_price, valid_from, valid_to)").eq("active", true);
  const now = new Date().toISOString();
  const lines: Record<string, unknown>[] = [];
  let total = new Decimal(0);
  for (const p of products ?? []) {
    const q = str(f, `sold:${p.id}`);
    if (q === "" || q === "0") continue;
    if (!DEC.test(q)) return { error: `"${q}" is not a valid quantity.` };
    const price = (p.product_prices as { unit_price: string; valid_from: string; valid_to: string | null }[])
      .filter((x) => !x.valid_to || x.valid_to > now)
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0]?.unit_price;
    if (price === undefined) return { error: "A product has no price yet. Set prices in Settings first." };
    const gross = new Decimal(q).times(price).toDecimalPlaces(2);
    total = total.plus(gross);
    lines.push({
      external_ref: `till-${shiftId}-${p.id}`, // one till-report line per product per shift
      transaction_at: now,
      pos_code: p.pos_code ?? p.sku,
      quantity: q,
      gross_amount: gross.toFixed(2),
      discount_amount: "0",
      tax_amount: "0",
      payment_method: "other",
    });
  }
  if (lines.length) {
    // Products without a POS code are matched by SKU for hand-entered sales
    const payload = JSON.stringify(lines);
    const { data: imp, error } = await supabase.rpc("import_pos_batch", {
      p_shift: shiftId, p_file_name: "Till report (entered by hand)", p_file_sha256: await sha256Hex(payload),
      p_storage_path: null, p_pos_total_sales: total.toFixed(2), p_pos_total_refunds: "0.00", p_lines: lines,
    });
    if (error) return { error: friendly(error) };
    if ((imp as { duplicates_skipped: number }).duplicates_skipped > 0) {
      return { error: "The till report was already entered for this shift. Totals already saved can’t be changed; explain any correction on the alert after closing." };
    }
  }
  const { error: tErr } = await supabase.rpc("record_till_totals", { p_shift: shiftId, p_cash: cash, p_card: card });
  if (tErr) return { error: friendly(tErr) };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: lines.length ? `Till report saved: ${lines.length} products, cash and card totals.` : "Cash and card totals saved." };
}

export async function addSpecial(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, businessId } = await requireSession();
  const price = money(str(f, "deal_price"));
  const per = Number(str(f, "items_per_deal"));
  const productIds = f.getAll("product_ids").map(String);
  if (!str(f, "name")) return { error: "Name the special, for example “Any 2 pre-rolls for R200”." };
  if (price === null) return { error: "Enter the deal price." };
  if (!Number.isInteger(per) || per < 1) return { error: "Enter how many items are in one deal." };
  if (!productIds.length) return { error: "Tick the products customers can choose from." };
  const { data, error } = await supabase
    .from("specials")
    .insert({ business_id: businessId, name: str(f, "name"), code: str(f, "code") || null, deal_price: price, items_per_deal: per })
    .select("id")
    .single();
  if (error) {
    if (error.message.includes("duplicate")) return { error: "That till code is already used by another special." };
    return { error: error.message.includes("row-level") ? "Only the owner can set up specials." : friendly(error) };
  }
  const { error: pErr } = await supabase.from("special_products").insert(productIds.map((id) => ({ special_id: data.id, product_id: id })));
  if (pErr) return { error: friendly(pErr) };
  revalidatePath("/settings");
  return { ok: "Special added. Staff can now record it during a shift." };
}

export async function toggleSpecial(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const { error } = await supabase.from("specials").update({ active: str(f, "active") === "true" }).eq("id", str(f, "special_id"));
  if (error) return { error: friendly(error) };
  revalidatePath("/settings");
  return { ok: str(f, "active") === "true" ? "Special switched on." : "Special switched off." };
}

export async function setLowStock(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const v = str(f, "low_stock_level");
  if (v !== "" && !DEC.test(v)) return { error: "Enter a number, or leave it empty for no warning." };
  const { data, error } = await supabase.from("products").update({ low_stock_level: v === "" ? null : v }).eq("id", str(f, "product_id")).select("id");
  if (error) return { error: friendly(error) };
  if (!data?.length) return { error: "Only the owner can change this." };
  revalidatePath("/settings");
  return { ok: "Saved." };
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
  const reason = str(f, "reason");
  const note = str(f, "explanation");
  if (!reason && !note) return { error: "Choose a reason." };
  if ((reason === "Other" || !reason) && !note) return { error: "Add a short note to explain what happened." };
  const explanation = reason && reason !== "Other" ? (note ? `${reason}: ${note}` : reason) : note;
  const { error } = await supabase.rpc("update_exception", {
    p_exception: str(f, "exception_id"),
    p_status: str(f, "status"),
    p_explanation: explanation,
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
  // Weighed products are priced per gram, as dispensaries sell them.
  const unitPrice = price;
  const { data, error } = await supabase
    .from("products")
    .insert({
      business_id: businessId,
      sku: str(f, "sku"),
      name: str(f, "name"),
      tracking_mode: mode,
      base_unit: base,
      display_unit: mode === "weight" ? "g" : "unit",
      pos_code: str(f, "pos_code") || null,
      category: str(f, "category") || null,
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

// A whole product list at once (from lib/products/import.ts, read in the browser)
export async function importProducts(items: { name: string; sku: string; pos_code: string | null; category: string; weight: boolean; price: string; low: string | null }[]): Promise<ActionState> {
  const { supabase, businessId, userId } = await requireSession();
  if (!items.length) return { error: "No new products to add." };
  if (items.length > 500) return { error: "Upload up to 500 products at a time." };
  let added = 0;
  const failed: string[] = [];
  for (const it of items) {
    if (!it.name?.trim() || !DEC.test(it.price)) { failed.push(it.name || "(no name)"); continue; }
    const { data, error } = await supabase.from("products").insert({
      business_id: businessId, sku: it.sku.slice(0, 40), name: it.name.slice(0, 120),
      tracking_mode: it.weight ? "weight" : "unit", base_unit: it.weight ? "g" : "unit", display_unit: it.weight ? "g" : "unit",
      pos_code: it.pos_code || null, category: it.category || null,
      low_stock_level: it.low && DEC.test(it.low) ? it.low : null,
    }).select("id").single();
    if (error) {
      if (error.message.includes("row-level")) return { error: "Only the owner can add products." };
      if (/up to \d+ products/.test(error.message)) { failed.push(`${it.name} (plan limit)`); break; }
      failed.push(it.name);
      continue;
    }
    await supabase.from("product_prices").insert({ product_id: data.id, unit_price: it.price, valid_from: new Date().toISOString(), created_by: userId });
    added++;
  }
  revalidatePath("/settings");
  revalidatePath("/today");
  return failed.length
    ? { ok: `Added ${added} product${added === 1 ? "" : "s"}. Not added: ${failed.slice(0, 8).join(", ")}${failed.length > 8 ? "…" : ""}.` }
    : { ok: `Added ${added} product${added === 1 ? "" : "s"}.` };
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

// How sales get into OnPoint: from a till file, or worked out from the counts
export async function setSalesSource(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, businessId } = await requireSession();
  const source = str(f, "sales_source");
  const { error } = await supabase.rpc("set_sales_source", { p_business: businessId, p_source: source });
  if (error) return { error: friendly(error) };
  revalidatePath("/settings");
  return {
    ok: source === "counts"
      ? "Saved. At each close, OnPoint works out what was sold from the counts and checks it against the money taken."
      : "Saved. Import your till file on each shift before closing.",
  };
}

// Remembers how this shop's till file is laid out and which items are which
export async function savePosLayout(layout: { columns?: Record<string, string>; links?: Record<string, string>; skip?: string[]; sizes?: Record<string, number> }): Promise<ActionState> {
  for (const v of Object.values(layout.sizes ?? {})) if (!(typeof v === "number" && v > 0 && v <= 1000)) return { error: "Grams in each sale must be a number above 0." };
  const { supabase, businessId } = await requireSession();
  const { error } = await supabase.rpc("set_pos_layout", { p_business: businessId, p_layout: layout });
  if (error) return { error: friendly(error) };
  return { ok: "Layout saved." };
}

// Cash and card totals from the till, for files without a payment column
export async function saveTillTotals(input: { shiftId: string; cash: string; card: string }): Promise<ActionState> {
  const { supabase } = await requireSession();
  const cash = money(input.cash.trim()), card = money(input.card.trim() || "0");
  if (cash === null || card === null) return { error: "Enter the cash and card totals as numbers." };
  const { error } = await supabase.rpc("record_till_totals", { p_shift: input.shiftId, p_cash: cash, p_card: card });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${input.shiftId}`);
  return { ok: "Cash and card totals saved." };
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

// ---------------------------------------------------------------------------
// Billing (owner) and admin
// ---------------------------------------------------------------------------
export async function startCheckout(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, businessId, role } = await requireSession();
  if (role !== "owner") return { error: "Only the owner can manage the plan." };
  const plan = str(f, "plan");
  if (!["starter", "business", "multi_site"].includes(plan)) return { error: "Choose a plan." };
  const { payfastConfigured } = await import("@/lib/payfast");
  if (!payfastConfigured()) return { error: "Online payment isn’t switched on yet. Please contact OnPoint." };

  const { data: inv, error } = await supabase.rpc("billing_create_invoice", { p_business: businessId, p_plan: plan, p_method: "card" });
  if (error) return { error: friendly(error) };
  redirect(`/billing/pay/${(inv as { id: string }).id}`);
}

export async function adminSetPlan(_: ActionState, f: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const days = Number(str(f, "days"));
  if (!Number.isFinite(days) || days < 0 || days > 400) return { error: "Enter days between 0 and 400." };
  const end = new Date(Date.now() + days * 86400_000).toISOString();
  const { error } = await supabase.rpc("admin_set_subscription", {
    p_business: str(f, "business_id"), p_plan: str(f, "plan"), p_status: str(f, "status"), p_period_end: end,
  });
  if (error) return { error: friendly(error) };
  revalidatePath("/admin");
  return { ok: "Plan updated." };
}

export async function requestFullCount(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const shiftId = str(f, "shift_id");
  const { error } = await supabase.rpc("request_full_count", { p_shift: shiftId });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: "Everything is on tonight's count list." };
}

export async function setCountSettings(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, businessId } = await requireSession();
  const { error } = await supabase.rpc("set_count_settings", {
    p_business: businessId,
    p_mode: str(f, "count_mode"),
    p_per_shift: Number(str(f, "spot_per_shift") || 12),
    p_full_days: Number(str(f, "full_count_days") || 7),
  });
  if (error) return { error: friendly(error) };
  revalidatePath("/settings");
  return { ok: "Saved." };
}

export async function setProductOptions(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const num = (k: string) => { const v = str(f, k).replace(",", "."); return v === "" ? null : v; };
  for (const k of ["low_stock_level", "allowance_pct", "container_weight"]) {
    const v = num(k);
    if (v !== null && !DEC.test(v)) return { error: `"${v}" isn't a number.` };
  }
  const allowance = num("allowance_pct");
  if (allowance !== null && Number(allowance) > 50) return { error: "The allowance can be at most 50%." };
  const { data, error } = await supabase.from("products").update({
    low_stock_level: num("low_stock_level"),
    allowance_pct: allowance,
    container_weight: num("container_weight"),
    always_count: f.get("always_count") === "on",
  }).eq("id", str(f, "product_id")).select("id");
  if (error) return { error: friendly(error) };
  if (!data?.length) return { error: "Only the owner can change products." };
  revalidatePath("/settings");
  return { ok: "Saved." };
}

export async function joinCount(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const shiftId = str(f, "shift_id");
  const { error } = await supabase.rpc("join_count", { p_shift: shiftId });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: "You’re in. Your share of the list is below." };
}

export async function setCounters(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireSession();
  const shiftId = str(f, "shift_id");
  const users = f.getAll("user_ids").map(String).filter(Boolean);
  const { error } = await supabase.rpc("set_counters", { p_shift: shiftId, p_users: users });
  if (error) return { error: friendly(error) };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: users.length ? `Shared between ${users.length} ${users.length === 1 ? "person" : "people"}.` : "Sharing switched off." };
}

// End-of-shift statement: three answers, photos, and the person's own password
export async function submitStatement(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, userId, businessId } = await requireSession();
  const svc = createServiceClient();
  const shiftId = str(f, "shift_id");
  const { data: shift } = await supabase.from("shifts").select("id, status, business_id").eq("id", shiftId).maybeSingle();
  if (!shift || shift.business_id !== businessId) return { error: "Shift not found." };
  if (!["active", "correction_requested"].includes(shift.status)) return { error: "Shift answers can only be saved while the shift is open." };

  // Who is answering: the signed-in person, or a teammate on a shared phone (PIN only)
  const answerer = str(f, "answerer") || userId;
  const method = str(f, "method") === "pin" ? "pin" : "password";
  if (answerer !== userId) {
    if (method !== "pin") return { error: "Teammates confirm with their own PIN." };
    const { data: m } = await svc.from("memberships").select("user_id").eq("business_id", businessId).eq("user_id", answerer).eq("active", true).maybeSingle();
    if (!m) return { error: "That person isn’t on your team." };
  }
  const { data: already } = await svc.from("shift_statements").select("id").eq("shift_id", shiftId).eq("user_id", answerer).maybeSingle();
  if (already) return { error: answerer === userId ? "You’ve already saved your shift answers." : "They’ve already saved their shift answers." };

  const yes = (k: string) => { const v = str(f, k); return v === "yes" ? true : v === "no" ? false : null; };
  const unrung = yes("unrung"), stockEvent = yes("stock_event");
  if (unrung === null || stockEvent === null) return { error: "Answer the first two questions with Yes or No." };
  const unrungDetail = str(f, "unrung_detail").slice(0, 1000), stockDetail = str(f, "stock_event_detail").slice(0, 1000);
  if (unrung && !unrungDetail) return { error: "Explain what was given out if you answered Yes." };
  if (stockEvent && !stockDetail) return { error: "Explain what happened to the stock if you answered Yes." };
  const notes = str(f, "notes").slice(0, 1000);

  const photos = f.getAll("photos").filter((x): x is File => x instanceof File && x.size > 0);
  const bad = checkPhotos(photos);
  if (bad) return { error: bad };

  if (method === "pin") {
    const pin = str(f, "pin");
    const { data: row } = await svc.from("staff_pins").select("pin_hash, failed, locked_until").eq("user_id", answerer).maybeSingle();
    if (!row) return { error: "No PIN is set yet. Confirm with your password and set a PIN." };
    if (row.locked_until && new Date(row.locked_until) > new Date()) {
      return { error: `Too many wrong tries. Try again in ${LOCK_MINUTES} minutes, or confirm with your password.` };
    }
    if (!PIN_RE.test(pin) || !pinMatches(pin, row.pin_hash)) {
      const failed = row.failed + 1;
      await svc.from("staff_pins").update({
        failed: failed >= MAX_TRIES ? 0 : failed,
        locked_until: failed >= MAX_TRIES ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
      }).eq("user_id", answerer);
      return { error: failed >= MAX_TRIES ? `Too many wrong tries. PIN locked for ${LOCK_MINUTES} minutes.` : "That PIN isn’t right." };
    }
    if (row.failed) await svc.from("staff_pins").update({ failed: 0, locked_until: null }).eq("user_id", answerer);
  } else {
    const password = String(f.get("password") ?? "");
    const { data: me } = await supabase.auth.getUser();
    if (!password || !me.user?.email || !(await passwordMatches(me.user.email, password))) {
      return { error: "Your password is incorrect. Use the password you sign in with." };
    }
    const newPin = str(f, "new_pin");
    if (newPin) {
      if (!PIN_RE.test(newPin)) return { error: "A PIN is 4 to 6 numbers." };
      await svc.from("staff_pins").upsert({ user_id: userId, pin_hash: hashPin(newPin), failed: 0, locked_until: null, updated_at: new Date().toISOString() });
    }
  }

  let paths: string[];
  try {
    paths = await storePhotos(`${businessId}/${shiftId}/${answerer}`, photos);
  } catch {
    return { error: "The photos couldn’t upload. Check your connection and try again." };
  }
  const { error } = await svc.from("shift_statements").insert({
    business_id: businessId, shift_id: shiftId, user_id: answerer,
    unrung, unrung_detail: unrung ? unrungDetail : null,
    stock_event: stockEvent, stock_event_detail: stockEvent ? stockDetail : null,
    notes: notes || null, photos: paths, pin_confirmed: method === "pin",
  });
  if (error) return { error: error.code === "23505" ? "These shift answers are already saved." : "Couldn’t save the shift answers. Try again." };
  revalidatePath(`/shifts/${shiftId}`);
  return { ok: answerer === userId ? "Your shift answers have been saved." : "Their shift answers have been saved." };
}

export async function setRequireStatement(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase, businessId } = await requireSession();
  const { error } = await supabase.rpc("set_require_statement", { p_business: businessId, p_on: f.get("require_statement") === "on" });
  if (error) return { error: friendly(error) };
  revalidatePath("/settings");
  return { ok: "Saved." };
}
