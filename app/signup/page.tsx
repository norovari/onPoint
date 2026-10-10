import type { Metadata } from "next";
import SignupForm from "./SignupForm";

export const metadata: Metadata = { title: "Start free" };

export default async function Signup({ searchParams }: { searchParams: Promise<{ b?: string }> }) {
  const { b } = await searchParams;
  return <SignupForm businessName={(b ?? "").slice(0, 80)} />;
}
