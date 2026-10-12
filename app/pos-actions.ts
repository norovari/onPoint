"use server";

// Connecting a POS (Loyverse) and reading from it. The access key is stored
// and used only on the server; the browser never sees it.
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireSession, isManager } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { itemsToProducts, lvList, receiptsToRows, type LvItem, type LvReceipt, type LvStore } from "@/lib/pos/loyverse";
import { categoryOf } from "@/lib/products/import";
import { importProducts, type ActionState } from "@/app/actions";

const AUTH_MSG = "Loyverse didn’t accept the access key. Check it’s copied in full and hasn’t been deleted or expired.";
const NET_MSG = "Couldn’t reach Loyverse just now. Try again in a minute.";

async function connection(businessId: string) {
  const { data } = await createServiceClient().from("pos_connections").select("token, store_id, store_name").eq("business_id", businessId).maybeSingle();
  return data?.token ? data : null;
}

export async function connectLoyverse(_: ActionState, f: FormData): Promise<ActionState & { stores?: { id: string; name: string }[] }> {
  const s = await requireSession();
  if (s.role !== "owner") return { error: "Only the owner can connect the POS." };
  const token = String(f.get("token") ?? "").trim();
  if (token.length < 10 || token.length > 400 || /\s/.test(token)) return { error: "Paste the whole access key from Loyverse." };
  let stores: LvStore[];
  try {
    stores = await lvList<LvStore>(token, "stores", "stores", {}, 2);
  } catch (e) {
    return { error: (e as Error).message === "auth" ? AUTH_MSG : NET_MSG };
  }
  const only = stores.length === 1 ? stores[0] : null;
  const { error } = await createServiceClient().from("pos_connections").upsert({
    business_id: s.businessId, provider: "loyverse", token,
    store_id: only?.id ?? null, store_name: only?.name ?? null,
    connected_by: s.userId, connected_at: new Date().toISOString(),
  });
  if (error) return { error: "Couldn’t save the connection. Try again." };
  revalidatePath("/settings");
  return only || stores.length === 0
    ? { ok: `Connected to Loyverse${only?.name ? ` (${only.name})` : ""}.` }
    : { ok: "Connected. Choose which Loyverse store this shop is.", stores: stores.map((x) => ({ id: x.id, name: x.name ?? x.id })) };
}

export async function chooseLoyverseStore(_: ActionState, f: FormData): Promise<ActionState> {
  const s = await requireSession();
  if (s.role !== "owner") return { error: "Only the owner can change this." };
  const [id, ...name] = String(f.get("store") ?? "").split("|");
  if (!id) return { error: "Choose a store." };
  await createServiceClient().from("pos_connections").update({ store_id: id, store_name: name.join("|") || null }).eq("business_id", s.businessId);
  revalidatePath("/settings");
  return { ok: "Saved." };
}

export async function disconnectPos(): Promise<ActionState> {
  const s = await requireSession();
  if (s.role !== "owner") return { error: "Only the owner can disconnect the POS." };
  await createServiceClient().from("pos_connections").update({ token: null, store_id: null, store_name: null }).eq("business_id", s.businessId);
  revalidatePath("/settings");
  return { ok: "Disconnected. You can also delete the key in Loyverse." };
}

// This shift's sales from Loyverse, as till rows for the normal import.
// Receipts already imported for this shift are left out.
export async function getLoyverseSales(shiftId: string): Promise<{ error?: string; rows?: string[][]; fileName?: string; sha256?: string; count?: number }> {
  const s = await requireSession();
  if (!isManager(s.role)) return { error: "Only managers and owners can bring in sales." };
  const conn = await connection(s.businessId);
  if (!conn) return { error: "Loyverse isn’t connected. The owner can connect it in Settings." };
  const { data: shift } = await s.supabase.from("shifts").select("opened_at").eq("id", shiftId).maybeSingle();
  if (!shift) return { error: "Shift not found." };
  let receipts: LvReceipt[];
  try {
    receipts = await lvList<LvReceipt>(conn.token!, "receipts", "receipts", {
      created_at_min: new Date(shift.opened_at).toISOString(),
      created_at_max: new Date().toISOString(),
      ...(conn.store_id ? { store_id: conn.store_id } : {}),
    });
  } catch (e) {
    return { error: (e as Error).message === "auth" ? AUTH_MSG : NET_MSG };
  }
  const { data: done } = await s.supabase.from("pos_sales_lines").select("external_ref").eq("shift_id", shiftId).like("external_ref", "LV-%");
  const seen = new Set((done ?? []).map((d) => String(d.external_ref).replace(/-\d+$/, "")));
  const fresh = receipts.filter((r) => !seen.has(`LV-${r.receipt_number}`) && !r.cancelled_at);
  if (fresh.length === 0) return { error: receipts.length ? "All of this shift’s Loyverse sales are already in." : "No Loyverse sales since this shift opened yet." };
  const rows = receiptsToRows(fresh);
  const sha256 = createHash("sha256").update(fresh.map((r) => r.receipt_number).sort().join(",")).digest("hex");
  const stamp = new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date());
  return { rows, fileName: `Loyverse ${stamp}`, sha256, count: fresh.length };
}

export async function importLoyverseProducts(): Promise<ActionState> {
  const s = await requireSession();
  if (s.role !== "owner") return { error: "Only the owner can add products." };
  const conn = await connection(s.businessId);
  if (!conn) return { error: "Connect Loyverse first." };
  let items: LvItem[];
  try {
    items = await lvList<LvItem>(conn.token!, "items", "items");
  } catch (e) {
    return { error: (e as Error).message === "auth" ? AUTH_MSG : NET_MSG };
  }
  const { data: existing } = await s.supabase.from("products").select("name, sku, pos_code");
  const built = itemsToProducts(items, (existing ?? []) as { name: string; sku: string; pos_code: string | null }[], categoryOf);
  if (built.items.length === 0) return { ok: built.skipped ? "Every Loyverse product is already in OnPoint." : "No products with a fixed price found in Loyverse." };
  const r = await importProducts(built.items);
  return r?.ok && built.skipped ? { ok: `${r.ok} ${built.skipped} were already here.` } : r;
}
