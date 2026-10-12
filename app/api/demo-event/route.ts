import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

// Records how far someone gets in a personal demo (opened, tried the staff
// view, submitted a sample close, opened the report, tapped Start free).
// Sent from the browser, so WhatsApp link previews (which don't run scripts)
// aren't counted. Stores no personal data: a random visitor id per browser.
const EVENTS = new Set(["open", "staff", "submit", "report", "signup"]);

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = JSON.parse(await req.text()); } catch { return new NextResponse(null, { status: 400 }); }
  const shop = String(body.shop ?? "").trim().slice(0, 80);
  const kind = body.kind === "bar" ? "bar" : "dispensary";
  const event = String(body.event ?? "");
  const visitor = /^[a-z0-9]{6,40}$/i.test(String(body.visitor ?? "")) ? String(body.visitor) : null;
  if (!shop || !EVENTS.has(event)) return new NextResponse(null, { status: 400 });
  const ua = req.headers.get("user-agent") ?? "";
  if (/bot|crawl|spider|preview|facebookexternalhit|whatsapp/i.test(ua)) return new NextResponse(null, { status: 204 });
  try {
    await createServiceClient().from("demo_events").insert({ shop, kind, event, visitor, mobile: /mobile|android|iphone/i.test(ua) });
  } catch { /* never break the demo over a missed count */ }
  return new NextResponse(null, { status: 204 });
}
