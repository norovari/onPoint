import type { Metadata } from "next";
import { PROVINCES } from "@/lib/agrilink";
import ListForm from "./ListForm";
import "./agrilink.css";

const DESCRIPTION = "List what you're harvesting and AgriLink finds buyers near you: greengrocers, caterers, restaurants and market agents.";

export const metadata: Metadata = {
  title: { absolute: "AgriLink · Sell your harvest" },
  description: DESCRIPTION,
  applicationName: "AgriLink",
  openGraph: { title: "AgriLink · Sell your harvest", description: DESCRIPTION, siteName: "AgriLink", type: "website" },
};

export default async function AgriLink({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const { p } = await searchParams;
  const province = PROVINCES.find((x) => x.toLowerCase().replace(/[^a-z]/g, "") === String(p ?? "").toLowerCase().replace(/[^a-z]/g, "")) ?? "Northern Cape";
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
        <ListForm province={province} />
        <p className="al-fine">
          Free to list. AgriLink only earns a small fee when a sale goes through, agreed with you first.
          Your number is only shared with buyers interested in your produce. AgriLink is run by Norovari (Pty) Ltd.
        </p>
      </main>
    </div>
  );
}
