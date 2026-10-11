import type { Metadata } from "next";
import Link from "next/link";
import { SampleReport } from "@/components/SampleReport";
import { PlanCards } from "@/components/PlanCards";
import { PLANS, TRIAL_DAYS, LAUNCH_DISCOUNT } from "@/lib/plans";

// Sample monthly report on its own page: /demo/The-Urb-Tribe/report
type Props = { params: Promise<{ name: string }> };

function businessName(slug: string) {
  let s = slug;
  try { s = decodeURIComponent(slug); } catch {}
  return s.replace(/-/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const name = businessName((await params).name);
  const title = name ? `${name}: sample monthly report` : "OnPoint sample monthly report";
  const description = "OnPoint – Dispensary Tracker. What your customers buy and when, stock to watch, and clear steps to take each month.";
  return { title: { absolute: title }, description, openGraph: { title, description, siteName: "OnPoint – Dispensary Tracker", type: "website" } };
}

export default async function SampleReportPage({ params }: Props) {
  const slug = (await params).name;
  const name = businessName(slug) || "Your dispensary";
  return (
    <main className="wrap" style={{ paddingTop: 24, paddingBottom: 48 }}>
      <p className="small"><Link href={`/demo/${slug}`}>← Back to the demo shift</Link> · <a href="#prices">See prices</a></p>
      <h1>{name}</h1>
      <p className="muted" style={{ marginTop: -8 }}>Monthly report</p>
      <SampleReport businessName={name} />
      <PlanCards signup={`/signup?b=${encodeURIComponent(name)}`} name={name} />
      <div className="sheet" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>Get this for {name}</h2>
        <p>{TRIAL_DAYS} days of everything free, then from R{PLANS[1].price} a month. Subscribe before your trial ends and your first {LAUNCH_DISCOUNT.months} months are {LAUNCH_DISCOUNT.pct}% off.</p>
        <Link href={`/signup?b=${encodeURIComponent(name)}`} className="button" style={{ width: "100%" }}>Start free</Link>
      </div>
    </main>
  );
}
