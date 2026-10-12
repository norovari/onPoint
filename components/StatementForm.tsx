"use client";

// End-of-shift statement: three questions, photos from the phone camera, and
// the person's own password in place of a signature.
import { useState, useTransition } from "react";
import { submitStatement } from "@/app/actions";

const MAX = 4;

// Shrink phone photos (often 4–8 MB) to about 1600px JPEG before upload
async function shrink(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.75));
    return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

function YesNo({ name, label, value, onChange }: { name: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: "12px 0 4px" }}>
      <legend style={{ fontWeight: 700, marginBottom: 6 }}>{label}</legend>
      <div style={{ display: "flex", gap: 16 }}>
        {["no", "yes"].map((v) => (
          <label key={v} style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} style={{ width: "auto" }} />
            {v === "yes" ? "Yes" : "No"}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export type Answerer = { id: string; name: string; hasPin: boolean; self: boolean };

export function StatementForm({ shiftId, questions, people }: {
  shiftId: string;
  questions: { unrung: string; stock_event: string; notes: string };
  people: Answerer[]; // who still needs to answer; the signed-in person first
}) {
  const [round, setRound] = useState(0);
  const [done, setDone] = useState<string>();
  return (
    <>
      {done && <p className="notice ok" role="status">{done}</p>}
      {people.length > 0 && (
        <OneStatement key={round} shiftId={shiftId} questions={questions} people={people}
          onSaved={(msg) => { setDone(msg); setRound((r) => r + 1); }} />
      )}
    </>
  );
}

function OneStatement({ shiftId, questions, people, onSaved }: {
  shiftId: string;
  questions: { unrung: string; stock_event: string; notes: string };
  people: Answerer[];
  onSaved: (msg: string) => void;
}) {
  const [who, setWho] = useState(people[0].id);
  const person = people.find((p) => p.id === who) ?? people[0];
  const [usePassword, setUsePassword] = useState(false);
  const method = person.self && (!person.hasPin || usePassword) ? "password" : "pin";
  const [unrung, setUnrung] = useState("");
  const [stock, setStock] = useState("");
  const [more, setMore] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok?: string; error?: string }>();
  const [pending, start] = useTransition();

  async function addPhotos(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    const small = await Promise.all([...list].map(shrink));
    setPhotos((p) => [...p, ...small].slice(0, MAX));
    setBusy(false);
  }

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    fd.delete("camera");
    fd.delete("more");
    fd.set("answerer", person.id);
    fd.set("method", method);
    photos.forEach((p) => fd.append("photos", p));
    start(async () => {
      const r = await submitStatement(undefined, fd);
      if (r?.ok) onSaved(r.ok); else setResult(r);
    });
  }

  return (
    <form className="sheet" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
      <h3 style={{ marginTop: 0 }}>Shift questions</h3>
      <p className="small muted" style={{ marginTop: 0 }}>Report anything unusual before you finish.</p>
      <input type="hidden" name="shift_id" value={shiftId} />

      {people.length > 1 && (
        <>
          <label htmlFor="st-who" style={{ marginTop: 0 }}>Who is answering?</label>
          <select id="st-who" value={who} onChange={(e) => { setWho(e.target.value); setUsePassword(false); setResult(undefined); }}>
            {people.map((p) => <option key={p.id} value={p.id} disabled={!p.self && !p.hasPin}>{p.self ? `${p.name} (you)` : p.hasPin ? p.name : `${p.name} (no PIN yet)`}</option>)}
          </select>
        </>
      )}

      <YesNo name="unrung" label={questions.unrung} value={unrung} onChange={setUnrung} />
      {unrung === "yes" && <textarea name="unrung_detail" aria-label="What left without being rung up" placeholder="What was given out, and how much?" required maxLength={1000} rows={2} />}

      <YesNo name="stock_event" label={questions.stock_event} value={stock} onChange={setStock} />
      {stock === "yes" && <textarea name="stock_event_detail" aria-label="What happened to the stock" placeholder="What happened?" required maxLength={1000} rows={2} />}

      <YesNo name="more" label={questions.notes} value={more} onChange={setMore} />
      {more === "yes" && <textarea id="st-notes" name="notes" aria-label="What should the owner know" placeholder="What should the owner know?" required maxLength={1000} rows={2} />}

      <label htmlFor="st-cam" style={{ marginTop: 12 }}>Photos <span className="hint">Take a clear photo of each scale reading and the cash drawer (up to {MAX}).</span></label>
      <input id="st-cam" name="camera" type="file" accept="image/*" capture="environment" multiple disabled={photos.length >= MAX}
        onChange={(e) => { addPhotos(e.target.files); e.target.value = ""; }} />
      {busy && <p className="small muted">Preparing photo…</p>}
      {photos.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: "relative" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={URL.createObjectURL(p)} alt={`Photo ${i + 1}`} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6, border: "1px solid var(--rule)" }} />
              <button type="button" className="quiet small" aria-label={`Remove photo ${i + 1}`} onClick={() => setPhotos((x) => x.filter((_, j) => j !== i))} style={{ display: "block", padding: 0 }}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {method === "pin" ? (
        <>
          <label htmlFor="st-pin" style={{ marginTop: 12 }}>{person.self ? "Confirm with your PIN." : `${person.name}, confirm with your PIN.`}</label>
          <input id="st-pin" name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,6}" maxLength={6} autoComplete="off" required style={{ maxWidth: 160, letterSpacing: "0.3em" }} />
          {person.self && <button type="button" className="quiet small" onClick={() => setUsePassword(true)} style={{ display: "block", marginTop: 6, padding: 0 }}>Forgot your PIN? Use your password</button>}
        </>
      ) : (
        <>
          <label htmlFor="st-pw" style={{ marginTop: 12 }}>Confirm with your password.</label>
          <input id="st-pw" name="password" type="password" autoComplete="current-password" required />
          <label htmlFor="st-newpin">{person.hasPin ? "New PIN" : "Set a PIN for next time"} <span className="hint">optional, 4 to 6 numbers. Quicker than your password, and works on a shared phone.</span></label>
          <input id="st-newpin" name="new_pin" type="password" inputMode="numeric" pattern="[0-9]{4,6}" maxLength={6} autoComplete="new-password" style={{ maxWidth: 160, letterSpacing: "0.3em" }} />
        </>
      )}

      {result?.error && <p className="notice error" role="alert">{result.error}</p>}
      <button type="submit" style={{ marginTop: 12, width: "100%" }} disabled={pending || busy || !unrung || !stock || !more || photos.length === 0}>
        {pending ? "Saving…" : "Save shift answers"}
      </button>
    </form>
  );
}
