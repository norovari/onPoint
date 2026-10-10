import Link from "next/link";
import { NavLinks } from "./NavLinks";

export function Shell({ children, businessName }: { children: React.ReactNode; businessName?: string }) {
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" aria-label="OnPoint home">
          On<b>Point</b>
        </Link>
        <NavLinks />
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
