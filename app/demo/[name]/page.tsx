import type { Metadata } from "next";
import Demo from "../Demo";

// Personal demo link: /demo/The-Urb-Tribe shows "The Urb Tribe".
// Hyphens in the link stand for spaces, so the link reads cleanly in WhatsApp.
type Props = { params: Promise<{ name: string }> };

function businessName(slug: string) {
  let s = slug;
  try { s = decodeURIComponent(slug); } catch {}
  return s.replace(/-/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const name = businessName((await params).name);
  const title = name ? `${name}: your OnPoint demo` : "OnPoint – Dispensary Tracker demo";
  const description = "OnPoint – Dispensary Tracker. Track your stock at the start and end of each shift, what each product earned, and what needs review when stock or cash don't tally.";
  return {
    title: { absolute: title },
    description,
    openGraph: { title, description, siteName: "OnPoint – Dispensary Tracker", type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function DemoNamePage({ params }: Props) {
  const name = businessName((await params).name) || "Your dispensary";
  return <Demo businessName={name} />;
}
