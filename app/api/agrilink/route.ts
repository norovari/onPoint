import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "@/lib/supabase/env";
import { toRows, type Listing } from "@/lib/agrilink";

// A farmer lists produce for sale from the public AgriLink page. Uses the
// public key: the database only allows adding listings, never reading them.
export async function POST(req: Request) {
  let body: Partial<Listing> & { website?: string };
  try { body = JSON.parse(await req.text()); } catch { return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 400 }); }
  if (body.website) return NextResponse.json({ ok: true }); // filled only by bots
  const { rows, error } = toRows(body, crypto.randomUUID());
  if (error || !rows) return NextResponse.json({ error }, { status: 400 });
  const { url, key } = supabaseEnv();
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: dbError } = await db.from("agri_listings").insert(rows);
  if (dbError) {
    console.error("agrilink insert", dbError.message);
    return NextResponse.json({ error: "We couldn't save that just now. Please try again in a minute." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, count: rows.length });
}
