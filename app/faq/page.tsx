import Link from "next/link";
import { Faq } from "@/components/Faq";
import { Shell } from "@/components/Shell";
import { createClient } from "@/lib/supabase/server";
import { CONTACT_EMAIL, LEGAL_NAME } from "@/lib/plans";

export const metadata = {
  title: "Questions",
  description: "How OnPoint works with your till, your staff and your stock.",
};

// Public for prospects; inside the app (with the normal menu) once signed in.
export default async function FaqPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) return <Shell><Faq signedIn /></Shell>;
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" style={{ textDecoration: "none" }}>On<b>Point</b></Link>
        <nav className="nav"><Link href="/pricing">Pricing</Link><Link href="/login">Sign in</Link></nav>
      </header>
      <main className="wrap">
        <Faq signedIn={false} />
        <footer className="muted small" style={{ marginTop: 40, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
          {LEGAL_NAME}{CONTACT_EMAIL ? `. Questions: ${CONTACT_EMAIL}` : ""}. <Link href="/terms">Terms, privacy and refunds</Link>
        </footer>
      </main>
    </>
  );
}
