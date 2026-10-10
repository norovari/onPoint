import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { createClient } from "@/lib/supabase/server";

export async function Shell({ children, businessName }: { children: React.ReactNode; businessName?: string }) {
  const supabase = await createClient();
  const { data: admin } = await supabase.rpc("am_platform_admin");
  return (
    <>
      <header className="topbar">
        <Link href="/today" className="brand" aria-label="OnPoint home">
          On<b>Point</b>
        </Link>
        <NavLinks admin={admin === true} />
      </header>
      <main className="wrap">
        {businessName && <p className="muted small" style={{ margin: 0 }}>{businessName}</p>}
        {children}
        <form action="/auth/signout" method="post" className="noprint" style={{ marginTop: 48 }}>
          <button type="submit" className="quiet">Sign out</button>
        </form>
      </main>
    </>
  );
}
