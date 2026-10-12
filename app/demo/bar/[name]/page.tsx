import type { Metadata } from "next";
import Demo from "../../Demo";
import { BAR_DESCRIPTION } from "@/lib/demo-meta";

// Personal bar demo link: /demo/bar/Sky-Lounge shows "Sky Lounge".
type Props = { params: Promise<{ name: string }> };

function businessName(slug: string) {
  let s = slug;
  try { s = decodeURIComponent(slug); } catch {}
  return s.replace(/-/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const name = businessName((await params).name);
  const title = name ? `${name}: your OnPoint demo` : "OnPoint for bars and lounges: demo";
  return {
    title: { absolute: title },
    description: BAR_DESCRIPTION,
    openGraph: { title, description: BAR_DESCRIPTION, siteName: "OnPoint", type: "website" },
    twitter: { card: "summary", title, description: BAR_DESCRIPTION },
  };
}

export default async function BarDemoNamePage({ params }: Props) {
  return <Demo kind="bar" businessName={businessName((await params).name) || "Your lounge"} />;
}
