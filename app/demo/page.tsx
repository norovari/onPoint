import type { Metadata } from "next";
import Demo from "./Demo";

type Props = { searchParams: Promise<{ b?: string }> };

function businessName(b?: string) {
  return (b ?? "").trim().slice(0, 80);
}

// The link preview (WhatsApp, SMS, email) shows the shop's own name.
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const name = businessName((await searchParams).b);
  const title = name ? `${name}: your OnPoint demo` : "OnPoint demo";
  const description = "See your stock at the start and end of each shift, what each product made, and alerts when stock or cash don't tally.";
  return {
    title: { absolute: title },
    description,
    openGraph: { title, description, siteName: "OnPoint", type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function DemoPage({ searchParams }: Props) {
  const name = businessName((await searchParams).b) || "Your dispensary";
  return <Demo businessName={name} />;
}
