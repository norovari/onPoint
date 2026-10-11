import { InsightsReport } from "@/components/InsightsReport";
import { SAMPLE_INSIGHTS } from "@/lib/insights-sample";

// The monthly report with example figures, laid out exactly like the real one
// (app/reports/monthly). Shown in the demo and to shops with no shifts yet.
export function SampleReport({ businessName, note }: { businessName: string; note?: string }) {
  return (
    <div>
      <p className="notice">
        <strong>Sample report.</strong> {note ?? `This is what ${businessName} would see after a month on OnPoint. The numbers are examples.`}
      </p>
      <InsightsReport data={SAMPLE_INSIGHTS} businessName={businessName} />
    </div>
  );
}
