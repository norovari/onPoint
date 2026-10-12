import type { Metadata } from "next";
import Demo from "../Demo";

// Bar and lounge demo: /demo/bar?b=Sky+Lounge (the short form is /demo/bar/Sky-Lounge).
type Props = { searchParams: Promise<{ b?: string }> };
const businessName = (b?: string) => (b ?? "").trim().slice(0, 80);

import { BAR_DESCRIPTION } from "@/lib/demo-meta";

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const name = businessName((await searchParams).b);
  const title = name ? `${name}: your OnPoint demo` : "OnPoint for bars and lounges: demo";
  return {
    title: { absolute: title },
    description: BAR_DESCRIPTION,
    openGraph: { title, description: BAR_DESCRIPTION, siteName: "OnPoint", type: "website" },
    twitter: { card: "summary", title, description: BAR_DESCRIPTION },
  };
}

export default async function BarDemoPage({ searchParams }: Props) {
  return <Demo kind="bar" businessName={businessName((await searchParams).b) || "Your lounge"} />;
}
