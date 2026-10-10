import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseEnv } from "./env";

// A Supabase client acting as the signed-in user (their cookie session).
// Every query it makes is filtered by Row Level Security in the database.
export async function createClient() {
  const cookieStore = await cookies();
  const { url, key } = supabaseEnv();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: the proxy refreshes the session instead.
        }
      },
    },
  });
}

export type Role = "staff" | "manager" | "owner";

export interface Session {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  fullName: string;
  businessId: string;
  businessName: string;
  role: Role;
}

// Resolve the signed-in user and their (first active) business, or redirect.
export async function requireSession(): Promise<Session> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const { data: membership } = await supabase
    .from("memberships")
    .select("business_id, role, businesses(name)")
    .eq("user_id", auth.user.id)
    .eq("active", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!membership) redirect("/onboarding");

  const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", auth.user.id).maybeSingle();
  const biz = membership.businesses as unknown as { name: string } | null;

  return {
    supabase,
    userId: auth.user.id,
    fullName: profile?.full_name || auth.user.email || "",
    businessId: membership.business_id,
    businessName: biz?.name ?? "",
    role: membership.role as Role,
  };
}

export const isManager = (role: Role) => role === "manager" || role === "owner";
