import "server-only";

// Email alerts through Resend (https://resend.com). Set RESEND_API_KEY and
// ALERT_FROM_EMAIL in Vercel to switch them on; without them, alerts still
// appear in the app and nothing is sent.
export async function sendShiftAlert(input: { to: string[]; businessName: string; shiftId: string; problems: number; statements?: string[] }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (!key || !from || input.to.length === 0) return;
  const link = site ? `${site.replace(/\/$/, "")}/shifts/${input.shiftId}` : "";
  const st = input.statements ?? [];
  const subject = input.problems
    ? `${input.businessName}: ${input.problems} thing${input.problems === 1 ? "" : "s"} to review tonight`
    : `${input.businessName}: Everything tallied tonight`;
  const text = [
    input.problems
      ? `The shift at ${input.businessName} has closed. ${input.problems} thing${input.problems === 1 ? " needs" : "s need"} review.`
      : `The shift at ${input.businessName} has closed. Everything tallied.`,
    ...(st.length ? ["", "Staff confirmations (each person’s answers, confirmed with their password):", "", ...st.flatMap((x) => [x, ""])] : [""]),
    link ? `Open the shift to view the photos${input.problems ? " and review any differences" : ""}: ${link}` : "Open OnPoint to see the details.",
    "",
    "OnPoint",
  ].join("\n");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: input.to, subject, text }),
    });
    if (!res.ok) console.error("Alert email failed", res.status, await res.text());
  } catch (e) {
    console.error("Alert email failed", e);
  }
}

type TrialEmail = {
  kind: "ending" | "ended"; businessName: string; reference: string; email: string;
  discountUntil: string; shiftsClosed: number; alerts: number; missingValue: number; cashShort: number;
};

const rand = (n: number) => `R${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;

// What OnPoint caught during the trial, in one or two sentences.
function trialSummary(t: TrialEmail, past: boolean) {
  if (t.shiftsClosed === 0) {
    return past
      ? "You didn't close a shift during the trial, so OnPoint hasn't had a chance to check anything yet."
      : "You haven't closed a shift yet. Close one today and see what OnPoint catches.";
  }
  const shifts = `${t.shiftsClosed} shift${t.shiftsClosed === 1 ? "" : "s"}`;
  if (t.alerts === 0) return `${past ? "During your trial you closed" : "You’ve closed"} ${shifts}, and everything tallied.`;
  const money = [
    t.missingValue > 0 ? `${rand(t.missingValue)} of missing stock` : "",
    t.cashShort > 0 ? `${rand(t.cashShort)} short in cash` : "",
  ].filter(Boolean).join(" and ");
  return `${past ? "During your trial you closed" : "You’ve closed"} ${shifts}, and ${t.alerts} item${t.alerts === 1 ? "" : "s"} need${t.alerts === 1 ? "s" : ""} review${money ? `, including ${money}` : ""}.`;
}

// The day before the trial ends, and once it has ended. Returns true if sent.
export async function sendTrialEmail(t: TrialEmail) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  if (!key || !from || !t.email) return false;
  const billing = site ? `${site}/billing` : "OnPoint → Billing";
  const until = new Intl.DateTimeFormat("en-ZA", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Johannesburg" }).format(new Date(t.discountUntil));
  const subject = t.kind === "ending" ? "Your OnPoint trial ends tomorrow" : "Your OnPoint trial has ended";
  const lines = t.kind === "ending"
    ? [
        "Hi,",
        "",
        `Your free OnPoint trial for ${t.businessName} ends tomorrow.`,
        "",
        trialSummary(t, false),
        "",
        "Subscribe before your trial ends to get 20% off your first 3 months:",
        billing,
      ]
    : [
        "Hi,",
        "",
        `Your free trial for ${t.businessName} has ended, and your shop is now on the Free plan. Some features are no longer available on this plan.`,
        "",
        trialSummary(t, true),
        "",
        `You can subscribe here to turn them back on (the 20% launch discount is still open until ${until}):`,
        billing,
      ];
  const text = [...lines, "", `Your reference: ${t.reference}`, "", "One Love 💚💛❤️", "Dee, OnPoint"].join("\n");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [t.email], subject, text }),
    });
    if (!res.ok) { console.error("Trial email failed", res.status, await res.text()); return false; }
    return true;
  } catch (e) {
    console.error("Trial email failed", e);
    return false;
  }
}

// Short notices to the OnPoint admin: new shops and payments.
// ADMIN_NOTIFY_EMAIL can override where they go.
export async function notifyAdmin(subject: string, lines: string[]) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  const to = process.env.ADMIN_NOTIFY_EMAIL || "nyorovai@gmail.com";
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  if (!key || !from) return;
  const text = [...lines, "", site ? `Admin: ${site}/admin` : "", "", "OnPoint"].filter((l, i, a) => l || a[i - 1]).join("\n");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) console.error("Admin notice failed", res.status, await res.text());
  } catch (e) {
    console.error("Admin notice failed", e);
  }
}
