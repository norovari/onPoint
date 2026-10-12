import type { Metadata } from "next";
import SignupForm from "./SignupForm";

export const metadata: Metadata = { title: "Start free" };

export default async function Signup({ searchParams }: { searchParams: Promise<{ b?: string; t?: string }> }) {
  const { b, t } = await searchParams;
  return <SignupForm businessName={(b ?? "").slice(0, 80)} shopType={t === "bar" ? "bar" : undefined} />;
}
