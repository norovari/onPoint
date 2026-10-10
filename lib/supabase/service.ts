import "server-only";
import { createClient } from "@supabase/supabase-js";

// Server-only client with the Supabase secret (service role) key. Used ONLY by
// the PayFast payment notification and the monthly billing job, which run without
// a signed-in user. It can only call the billing functions granted to it.
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set SUPABASE_SECRET_KEY (server only) to take payments.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
