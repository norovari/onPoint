import type { Metadata } from "next";
import Demo from "./Demo";

export const metadata: Metadata = { title: "Demo" };

export default async function DemoPage({ searchParams }: { searchParams: Promise<{ b?: string }> }) {
  const { b } = await searchParams;
  const name = (b ?? "").trim().slice(0, 80) || "Your dispensary";
  return <Demo businessName={name} />;
}
