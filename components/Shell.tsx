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
        <div className="noprint" style={{ marginTop: 48, display: "flex", gap: 16, alignItems: "center" }}>
          <Link href="/faq" className="small">Help and questions</Link>
          <form action="/auth/signout" method="post">
            <button type="submit" className="quiet">Sign out</button>
          </form>
        </div>
      </main>
    </>
  );
}
