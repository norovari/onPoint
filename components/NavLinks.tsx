"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/today", label: "Today" },
  { href: "/shifts", label: "Shifts" },
  { href: "/exceptions", label: "Alerts" },
  { href: "/settings", label: "Settings" },
  { href: "/billing", label: "Plan" },
];

export function NavLinks({ admin = false }: { admin?: boolean }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map((l) => {
        const active = path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
      {admin && <Link href="/admin" aria-current={path.startsWith("/admin") ? "page" : undefined}>Admin</Link>}
    </nav>
  );
}
