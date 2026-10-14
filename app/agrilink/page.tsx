import type { Metadata } from "next";
import { createClient } from "@supabase/supabase-js";
import { PLANS, PROVINCES } from "@/lib/agrilink";
import { supabaseEnv } from "@/lib/supabase/env";
import ListForm from "./ListForm";
import "./agrilink.css";

const DESCRIPTION = "List what you're harvesting and AgriLink finds buyers near you: greengrocers, caterers, restaurants and market agents.";

export const metadata: Metadata = {
  title: { absolute: "AgriLink · Sell your harvest" },
  description: DESCRIPTION,
  applicationName: "AgriLink",
  openGraph: { title: "AgriLink · Sell your harvest", description: DESCRIPTION, siteName: "AgriLink", type: "website" },
};

type Need = { id: string; created_at: string; town: string; buyer_kind: string; buyer: string | null; crop: string; qty: number; unit: string; frequency: string; price_note: string | null };
const FREQ: Record<string, string> = { weekly: "every week", fortnightly: "every 2 weeks", monthly: "every month", once: "once-off" };

// Confirmed buyer needs (added by AgriLink after speaking to the buyer).
async function needsFor(province: string): Promise<Need[]> {
  try {
    const { url, key } = supabaseEnv();
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data } = await db.rpc("agri_needs_public", { p_province: province });
    return (data ?? []) as Need[];
  } catch { return []; }
}

export default async function AgriLink({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const { p } = await searchParams;
  const province = PROVINCES.find((x) => x.toLowerCase().replace(/[^a-z]/g, "") === String(p ?? "").toLowerCase().replace(/[^a-z]/g, "")) ?? "Northern Cape";
  const needs = await needsFor(province);
  return (
    <div className="al">
      <header className="al-head">
        <div className="al-brand">Agri<span>Link</span></div>
        <span className="al-pilot">Pilot</span>
      </header>
      <main className="al-main">
        <section className="al-hero">
          <h1>Sell your harvest to buyers near you</h1>
          <p>Tell us what you have. We find greengrocers, caterers, restaurants and market agents in {province} who want it, and put you in touch on WhatsApp.</p>
          <ol className="al-steps">
            <li><b>1</b>List your crops below (takes 2 minutes)</li>
            <li><b>2</b>We match you with buyers looking for them</li>
            <li><b>3</b>You agree the price and delivery, and get paid by the buyer</li>
          </ol>
        </section>
        <section className="al-needs" aria-labelledby="al-needs-h">
          <h2 id="al-needs-h">Buyers looking now in {province}</h2>
          {needs.length ? (
            <>
              <p className="al-sub">Each of these buyers has spoken to us and told us what they need. Updated as orders are filled.</p>
              <ul className="al-need-list">
                {needs.map((n) => (
                  <li key={n.id} className="al-need">
                    <div className="al-need-crop">{n.crop}</div>
                    <div className="al-need-qty">{Number(n.qty)} {n.unit} <span>{FREQ[n.frequency] ?? ""}</span></div>
                    <div className="al-need-who">{n.buyer ? <b>{n.buyer}</b> : n.buyer_kind}{n.buyer ? ` · ${n.buyer_kind}` : ""} · {n.town}{n.price_note ? ` · ${n.price_note}` : ""}</div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="al-sub al-empty">We&apos;re speaking to greengrocers, fresh produce wholesalers, caterers and supermarkets{province === "Northern Cape" ? " in Kimberley, Upington, Kathu, Postmasburg, De Aar and Springbok" : ` in ${province}`}. Buyers appear here once they&apos;ve told us what they need, so list your crops now to be matched first.</p>
          )}
        </section>
        <ListForm province={province} />
        <section className="al-plans" aria-labelledby="al-plans-h">
          <h2 id="al-plans-h">Plans</h2>
          <p className="al-sub">Free during the pilot. You only start paying after your first buyer enquiry through AgriLink. No cut of your sales, ever. Buyers use AgriLink free.</p>
          <div className="al-plan-grid">
            {PLANS.map((p) => (
              <article key={p.id} className={`al-plan${p.id === "grower" ? " al-plan-pop" : ""}`}>
                <div className="al-plan-top"><h3>{p.name}</h3>{p.id === "grower" && <span className="al-pilot">Recommended</span>}</div>
                <div className="al-price">R{p.price}<span> a month</span></div>
                <div className="al-who">{p.who}</div>
                <ul>{p.points.map((x) => <li key={x}>{x}</li>)}</ul>
              </article>
            ))}
          </div>
        </section>
        <p className="al-fine">
          Your number is only shared with buyers interested in your produce. AgriLink is run by Norovari (Pty) Ltd.
        </p>
      </main>
    </div>
  );
}
