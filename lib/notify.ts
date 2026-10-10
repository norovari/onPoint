import "server-only";

// Email alerts through Resend (https://resend.com). Set RESEND_API_KEY and
// ALERT_FROM_EMAIL in Vercel to switch them on; without them, alerts still
// appear in the app and nothing is sent.
export async function sendShiftAlert(input: { to: string[]; businessName: string; shiftId: string; problems: number }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (!key || !from || input.to.length === 0) return;
  const link = site ? `${site.replace(/\/$/, "")}/shifts/${input.shiftId}` : "";
  const subject = `${input.businessName}: shift doesn’t tally (${input.problems} alert${input.problems === 1 ? "" : "s"})`;
  const text = [
    `A shift at ${input.businessName} was just closed and ${input.problems} thing${input.problems === 1 ? "" : "s"} didn’t tally.`,
    "",
    link ? `Open the shift to see and clear the alerts: ${link}` : "Open OnPoint to see and clear the alerts.",
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
