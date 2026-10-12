"use client";

// Settings: connect Loyverse with an access key, choose the store, bring in
// products, or disconnect. The key goes to the server and is never shown again.
import { useState, useTransition } from "react";
import { chooseLoyverseStore, connectLoyverse, disconnectPos, importLoyverseProducts } from "@/app/pos-actions";

type Conn = { provider: string; store_name: string | null; store_id: string | null; connected_at: string } | null;

export function PosConnect({ conn }: { conn: Conn }) {
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>();
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok?: string; error?: string; stores?: { id: string; name: string }[] } | undefined>) =>
    start(async () => { const r = await fn(); setMsg(r); if (r && "stores" in r && r.stores) setStores(r.stores); });

  return (
    <div className="sheet">
      {conn ? (
        <>
          <p style={{ marginTop: 0 }}><strong>Connected to Loyverse</strong>{conn.store_name ? ` · ${conn.store_name}` : ""}</p>
          <p className="small muted">At close, staff tap <strong>Get sales from Loyverse</strong> instead of uploading a file. OnPoint only reads your sales and products; it never changes anything in Loyverse.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" disabled={pending} onClick={() => run(importLoyverseProducts)}>{pending ? "Working…" : "Bring in products from Loyverse"}</button>
            <button type="button" className="quiet" disabled={pending} onClick={() => { if (confirm("Disconnect Loyverse? Staff will need to upload a till file instead.")) run(disconnectPos); }}>Disconnect</button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); run(() => connectLoyverse(undefined, fd)); }}>
          <p style={{ marginTop: 0 }}><strong>Use Loyverse?</strong> Connect it and sales come in by themselves at close, with no file to upload.</p>
          <ol className="small" style={{ paddingLeft: 18 }}>
            <li>In the Loyverse Back Office, open <strong>Access tokens</strong> and tap <strong>+ Add access token</strong>.</li>
            <li>Name it “OnPoint”, save, and copy the token.</li>
            <li>Paste it here.</li>
          </ol>
          <label htmlFor="lv-token">Loyverse access token</label>
          <input id="lv-token" name="token" type="password" autoComplete="off" required />
          <p className="small muted">Stored securely and only used to read your sales and products. You can delete the token in Loyverse at any time to cut off access.</p>
          <button type="submit" disabled={pending}>{pending ? "Connecting…" : "Connect Loyverse"}</button>
        </form>
      )}
      {stores.length > 1 && (
        <form style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); run(async () => { const r = await chooseLoyverseStore(undefined, fd); setStores([]); return r; }); }}>
          <label htmlFor="lv-store">Which Loyverse store is this shop?</label>
          <select id="lv-store" name="store" required defaultValue="">
            <option value="" disabled>Choose…</option>
            {stores.map((x) => <option key={x.id} value={`${x.id}|${x.name}`}>{x.name}</option>)}
          </select>
          <div style={{ marginTop: 8 }}><button type="submit" disabled={pending}>Save</button></div>
        </form>
      )}
      {msg?.error && <p className="notice error" role="alert">{msg.error}</p>}
      {msg?.ok && <p className="notice ok" role="status">{msg.ok}</p>}
    </div>
  );
}
