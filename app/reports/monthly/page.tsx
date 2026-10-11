import Link from "next/link";
import { requireSession } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { SampleReport } from "@/components/SampleReport";
import { InsightsReport } from "@/components/InsightsReport";
import { normalise } from "@/lib/insights";

export const metadata = { title: "Monthly report" };

// Business and Multi-site plans: sales trends, what customers buy and when,
// stock to watch, what didn't tally, and what to do about it.
export default async function Monthly() {
  const s = await requireSession();
  const { supabase, businessId } = s;
  const { data: plan } = await supabase.rpc("business_plan", { p_business: businessId });
  const allowed = ["business", "multi_site"].includes((plan as { plan: string }).plan);

  if (!allowed) {
    return (
      <Shell businessName={s.businessName}>
        <h1>Monthly report</h1>
        <div className="sheet" style={{ borderStyle: "dashed", borderWidth: 2 }}>
          <h2 style={{ marginTop: 0 }}>Part of the Business plan</h2>
          <p>See what your customers buy and when, which stock runs low or sits on the shelf, what didn’t tally, and clear steps to take each month.</p>
          <Link href="/billing" className="button">See plans</Link>
        </div>
        <h2>What it looks like</h2>
        <SampleReport businessName={s.businessName} note="This is what your report would look like on the Business plan. The numbers are examples." />
      </Shell>
    );
  }

  const { data, error } = await supabase.rpc("monthly_insights", { p_business: businessId, p_days: 30 });
  const insights = data ? normalise(data) : null;

  return (
    <Shell businessName={s.businessName}>
      <h1>Monthly report</h1>
      {error && <p className="notice">The report couldn’t load just now. Try again in a minute.</p>}
      {insights && insights.shifts_closed === 0 ? (
        <SampleReport businessName={s.businessName} note="Your own report fills in as you close shifts. Until then, here’s a sample. The numbers are examples." />
      ) : insights ? (
        <InsightsReport data={insights} businessName={s.businessName} />
      ) : null}
    </Shell>
  );
}
