import { ALERT_REASONS } from "@/lib/reasons";

// Reason pick-list plus a note, shared by the alert forms.
export function ReasonFields({ id, label }: { id: string; label: string }) {
  return (
    <>
      <label htmlFor={`reason-${id}`}>{label}</label>
      <select id={`reason-${id}`} name="reason" defaultValue="" required>
        <option value="" disabled>Choose a reason</option>
        {ALERT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <label htmlFor={`ex-${id}`}>Note <span className="hint">required if you choose “Other”</span></label>
      <textarea id={`ex-${id}`} name="explanation" rows={2} />
    </>
  );
}
