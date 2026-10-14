"use client";
import { useState } from "react";
import { CROPS, PROVINCES, UNITS, type CropRow } from "@/lib/agrilink";

const blank = (): CropRow => ({ crop: "", qty: "", unit: "crates", price: "", from: "" });

export default function ListForm({ province: initialProvince }: { province: string }) {
  const [farmer, setFarmer] = useState("");
  const [farm, setFarm] = useState("");
  const [phone, setPhone] = useState("");
  const [province, setProvince] = useState(initialProvince);
  const [town, setTown] = useState("");
  const [crops, setCrops] = useState<CropRow[]>([blank()]);
  const [delivery, setDelivery] = useState<"deliver" | "collect">("deliver");
  const [notes, setNotes] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<CropRow[] | null>(null);

  const setCrop = (i: number, k: keyof CropRow, v: string) => setCrops((cs) => cs.map((c, j) => (j === i ? { ...c, [k]: v } : c)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!consent) { setError("Please tick the box so we may share your produce with buyers."); return; }
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/agrilink", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ farmer, farm, phone, province, town, crops, delivery, notes, consent, website }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.error || "Something went wrong. Please try again."); return; }
      setDone(crops.filter((c) => c.crop.trim()));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setError("No connection. Check your signal and try again.");
    } finally { setBusy(false); }
  }

  if (done) {
    const share = `I've listed my harvest on AgriLink so buyers can find it. You can list yours here: ${typeof window !== "undefined" ? window.location.origin : ""}/agrilink`;
    return (
      <section className="al-card al-done" aria-live="polite">
        <h2>Thank you, {farmer.split(" ")[0]}. Your harvest is listed.</h2>
        <ul>{done.map((c, i) => <li key={i}><b>{c.crop}</b> · {c.qty} {c.unit}{c.price ? ` · R${c.price} per ${c.unit.replace(/s$/, "")}` : ""}</li>)}</ul>
        <p>We&apos;ll WhatsApp you on <b>{phone}</b> when a buyer wants it. If something changes (sold out, new crop ready), just list again.</p>
        <div className="al-row">
          <a className="al-btn al-wa" href={`https://wa.me/?text=${encodeURIComponent(share)}`} target="_blank" rel="noopener">Share with another farmer</a>
          <button className="al-btn al-ghost" type="button" onClick={() => { setDone(null); setCrops([blank()]); setConsent(false); }}>List more crops</button>
        </div>
      </section>
    );
  }

  return (
    <form className="al-card" onSubmit={submit} noValidate>
      <h2>Your details</h2>
      <div className="al-grid">
        <label>Your name<input value={farmer} onChange={(e) => setFarmer(e.target.value)} required maxLength={80} autoComplete="name" /></label>
        <label>Farm or co-op name <i>(optional)</i><input value={farm} onChange={(e) => setFarm(e.target.value)} maxLength={80} /></label>
        <label>WhatsApp number<input value={phone} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" autoComplete="tel" placeholder="082 123 4567" maxLength={20} /></label>
        <label>Province<select value={province} onChange={(e) => setProvince(e.target.value)}>{PROVINCES.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label className="al-full">Nearest town<input value={town} onChange={(e) => setTown(e.target.value)} maxLength={60} placeholder="e.g. Upington" /></label>
      </div>

      <h2>What do you have for sale?</h2>
      <datalist id="al-crops">{CROPS.map((c) => <option key={c} value={c} />)}</datalist>
      {crops.map((c, i) => (
        <fieldset className="al-crop" key={i}>
          <legend>Crop {crops.length > 1 ? i + 1 : ""}</legend>
          <div className="al-grid">
            <label className="al-full">Crop<input list="al-crops" value={c.crop} onChange={(e) => setCrop(i, "crop", e.target.value)} maxLength={40} placeholder="e.g. Tomatoes" /></label>
            <label>How much<input inputMode="decimal" value={c.qty} onChange={(e) => setCrop(i, "qty", e.target.value)} placeholder="e.g. 50" /></label>
            <label>Unit<select value={c.unit} onChange={(e) => setCrop(i, "unit", e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></label>
            <label>Your price per {c.unit.replace(/s$/, "")} (R) <i>(optional)</i><input inputMode="decimal" value={c.price} onChange={(e) => setCrop(i, "price", e.target.value)} placeholder="e.g. 90" /></label>
            <label>Ready from<input type="date" value={c.from} onChange={(e) => setCrop(i, "from", e.target.value)} /></label>
          </div>
          {crops.length > 1 && <button type="button" className="al-link" onClick={() => setCrops((cs) => cs.filter((_, j) => j !== i))}>Remove this crop</button>}
        </fieldset>
      ))}
      {crops.length < 12 && <button type="button" className="al-btn al-ghost" onClick={() => setCrops((cs) => [...cs, blank()])}>+ Add another crop</button>}

      <h2>Getting it to the buyer</h2>
      <div className="al-choice" role="radiogroup" aria-label="Delivery">
        <label><input type="radio" name="delivery" checked={delivery === "deliver"} onChange={() => setDelivery("deliver")} /> I can deliver</label>
        <label><input type="radio" name="delivery" checked={delivery === "collect"} onChange={() => setDelivery("collect")} /> Buyer must collect</label>
      </div>
      <label className="al-block">Anything else buyers should know? <i>(optional)</i>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder="Grade, packaging, how often you harvest" />
      </label>
      <input className="al-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
      <label className="al-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I agree that AgriLink may share my produce details and WhatsApp number with buyers, and contact me on WhatsApp.</label>
      {error && <p className="al-error" role="alert">{error}</p>}
      <button className="al-btn al-go" type="submit" disabled={busy}>{busy ? "Saving…" : "List my harvest"}</button>
    </form>
  );
}
