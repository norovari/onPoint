import { InsightsReport } from "@/components/InsightsReport";
import { SAMPLE_INSIGHTS } from "@/lib/insights-sample";

// The monthly report with example figures, laid out exactly like the real one
// (app/reports/monthly). Shown in the demo and to shops with no shifts yet.
export function SampleReport({ businessName, note }: { businessName: string; note?: string }) {
  return (
    <div>
      <p className="notice">
        <strong>Sample monthly report.</strong> {note ?? `These example figures show what ${businessName} could see after a month using OnPoint.`}
      </p>
      <InsightsReport data={SAMPLE_INSIGHTS} businessName={businessName} />
    </div>
  );
}
