"use client";

// Import a sales export from any till (CSV or Excel). OnPoint works out the
// columns and links the till's items to your products; you confirm anything
// it isn't sure about once, and it remembers for next time.
import { useMemo, useState, useTransition } from "react";
import Papa from "papaparse";
import { sha256Hex } from "@/lib/pos/csv";
import {
  FIELDS, buildLines, cellText, collectItems, detectDelimiter, findHeaderRow, guessMapping, linkItems,
  type Field, type Layout, type Mapping, type Product,
} from "@/lib/pos/smart";
import { importPos, savePosLayout, saveTillTotals } from "@/app/actions";
import { formatZar } from "@/lib/calculations";

type Item = { key: string; code: string; name: string; count: number };
const SKIP = "__skip__";

export function PosImport({ shiftId, products, layout }: { shiftId: string; products: Product[]; layout: Layout }) {
  const [fileName, setFileName] = useState("");
  const [hash, setHash] = useState("");
  const tag = hash.slice(0, 12);
  const [rows, setRows] = useState<string[][]>([]);
  const [header, setHeader] = useState(0);
  const [mapping, setMapping] = useState<Mapping>({});
  const [showMap, setShowMap] = useState(false);
  const [links, setLinks] = useState<Record<string, string>>(layout.links ?? {});
  const [skip, setSkip] = useState<string[]>(layout.skip ?? []);
  const [toLink, setToLink] = useState<Item[]>([]);
  const [cash, setCash] = useState("");
  const [card, setCard] = useState("");
  const [readError, setReadError] = useState("");
  const [result, setResult] = useState<{ error?: string; ok?: string } | undefined>();
  const [pending, start] = useTransition();

  const headers = rows[header] ?? [];
  const body = useMemo(() => rows.slice(header + 1), [rows, header]);

  function relink(m: Mapping, b: string[][]) {
    const items = collectItems(b, m);
    const l = linkItems(items, products, { links: layout.links, skip: layout.skip });
    setLinks((prev) => ({ ...prev, ...l.linked }));
    setToLink(items.filter((it) => !(layout.skip ?? []).includes(it.key) && !l.linked[it.key]));
  }

  async function onFile(f: File | null) {
    setResult(undefined); setReadError(""); setRows([]); setToLink([]);
    if (!f) return;
    setFileName(f.name);
    try {
      let data: string[][];
      if (/\.xlsx$/i.test(f.name)) {
        const { readSheet } = await import("read-excel-file/browser");
        data = (await readSheet(f)).map((r) => r.map(cellText));
      } else if (/\.xls$/i.test(f.name)) {
        setReadError("This is an old Excel file (.xls). Open it and save it as .xlsx or CSV, then choose it again.");
        return;
      } else {
        const text = (await f.text()).replace(/^\uFEFF/, "");
        data = Papa.parse<string[]>(text.trim(), { delimiter: detectDelimiter(text), skipEmptyLines: false }).data;
      }
      data = data.map((r) => r.map((c) => (c ?? "").toString()));
      setHash(await sha256Hex(JSON.stringify(data)));
      const h = findHeaderRow(data);
      const g = guessMapping(data[h] ?? [], layout.columns);
      setRows(data); setHeader(h); setMapping(g.mapping); setShowMap(!g.sure);
      relink(g.mapping, data.slice(h + 1));
    } catch {
      setReadError("This file couldn't be read. Save it from your till as CSV or Excel (.xlsx) and try again.");
    }
  }

  function setField(f: Field, v: string) {
    const m = { ...mapping };
    if (v === "") delete m[f]; else m[f] = Number(v);
    setMapping(m);
    if (f === "code" || f === "name") relink(m, body);
  }

  const built = useMemo(
    () => (rows.length ? buildLines(body, mapping, links, skip, products, new Date(), tag) : null),
    [rows.length, body, mapping, links, skip, products, tag],
  );
  const missing = FIELDS.filter((f) => f.required && mapping[f.key] === undefined).length > 0
    || (mapping.name === undefined && mapping.code === undefined)
    || (mapping.amount === undefined && mapping.price === undefined);
  const open = toLink.filter((it) => !links[it.key] && !skip.includes(it.key));
  const sample = (i: number | undefined) => (i === undefined ? "" : body.find((r) => r[i])?.[i] ?? "");

  function doImport() {
    if (!built) return;
    start(async () => {
      const columns = Object.fromEntries(Object.entries(mapping).map(([f, i]) => [f, headers[i as number]]));
      const saved = await savePosLayout({ columns, links, skip });
      if (saved?.error) { setResult(saved); return; }
      const r = await importPos({ shiftId, fileName: fileName || "till.csv", sha256: hash, totals: built.totals, lines: built.lines });
      if (r?.error) { setResult(r); return; }
      if (!built.hasPayment && cash.trim()) {
        const t = await saveTillTotals({ shiftId, cash, card });
        if (t?.error) { setResult({ error: `${r?.ok} But the cash and card totals didn't save: ${t.error}` }); return; }
      }
      setResult(r);
    });
  }

  return (
    <div>
      <label htmlFor="pos-file">
        Your till’s sales export <span className="hint">CSV or Excel, straight from the till. Any layout.</span>
      </label>
      <input id="pos-file" type="file" accept=".csv,.txt,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      {readError && <p className="notice error" role="alert">{readError}</p>}

      {rows.length > 0 && (
        <>
          {/* Columns */}
          {!showMap && !missing ? (
            <p className="small" style={{ marginTop: 12 }}>
              Read as: {FIELDS.filter((f) => mapping[f.key] !== undefined).map((f) => `${f.label} = “${headers[mapping[f.key]!]}”`).join(", ")}.{" "}
              <button type="button" className="quiet" onClick={() => setShowMap(true)}>Change</button>
            </p>
          ) : (
            <div className="sheet" style={{ marginTop: 12 }}>
              <p style={{ marginTop: 0 }}><strong>Which column is which?</strong> We’ll remember this for next time.</p>
              {FIELDS.map((f) => (
                <div key={f.key} className="row" style={{ alignItems: "end", marginBottom: 6 }}>
                  <div>
                    <label htmlFor={`map-${f.key}`}>{f.label}{f.required ? "" : " (if there is one)"}</label>
                    <select id={`map-${f.key}`} value={mapping[f.key] ?? ""} onChange={(e) => setField(f.key, e.target.value)}>
                      <option value="">Not in this file</option>
                      {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </select>
                  </div>
                  <div className="small muted" style={{ paddingBottom: 10 }}>{sample(mapping[f.key]) && `e.g. ${sample(mapping[f.key])}`}</div>
                </div>
              ))}
              {missing && <p className="notice" role="status">Choose the product (name or code), the quantity, and the line total or unit price.</p>}
              {!missing && <button type="button" onClick={() => setShowMap(false)}>Done</button>}
            </div>
          )}

          {/* Items not yet linked to a product */}
          {!missing && open.length > 0 && (
            <div className="sheet" style={{ marginTop: 12 }}>
              <p style={{ marginTop: 0 }}><strong>Which product is this?</strong> {open.length === 1 ? "1 item in the file doesn’t" : `${open.length} items in the file don’t`} match a product yet. We’ll remember your choice.</p>
              <ul className="lines">
                {open.slice(0, 40).map((it) => (
                  <li key={it.key} className="line">
                    <span className="name" style={{ margin: 0 }}>{it.name || it.code}{it.name && it.code ? <span className="hint"> {it.code}</span> : null}</span>
                    <select aria-label={`Product for ${it.name || it.code}`} defaultValue="" onChange={(e) => {
                      const v = e.target.value;
                      if (v === SKIP) setSkip((s) => [...s, it.key]);
                      else if (v) setLinks((l) => ({ ...l, [it.key]: v }));
                    }}>
                      <option value="">Choose…</option>
                      {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      <option value={SKIP}>Not stock we count (e.g. papers, lighters)</option>
                    </select>
                  </li>
                ))}
              </ul>
              {open.length > 40 && <p className="small muted">…and {open.length - 40} more. Link these first, then the rest appear.</p>}
            </div>
          )}

          {/* Check and import */}
          {!missing && built && (
            <div className="sheet" style={{ background: "var(--paper)", marginTop: 12 }}>
              <p style={{ margin: 0 }}>
                {built.lines.length} sales lines. Sales {formatZar(built.totals.sales)}{Number(built.totals.refunds) ? `, refunds ${formatZar(built.totals.refunds)}` : ""}.
                {built.hasPayment && Object.keys(built.byMethod).length > 0 && <> ({Object.entries(built.byMethod).map(([m, v]) => `${m} ${formatZar(v)}`).join(", ")})</>}
                {built.skipped > 0 && <> {built.skipped} non-stock line{built.skipped === 1 ? "" : "s"} left out.</>}
              </p>
              {built.errors.length > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary className="small">{built.errors.length} row{built.errors.length === 1 ? "" : "s"} couldn’t be read and will be left out</summary>
                  <ul className="small" style={{ paddingLeft: 18 }}>{built.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}</ul>
                </details>
              )}
              {open.length > 0 && <p className="small" style={{ color: "var(--variance)" }}>{open.length} item{open.length === 1 ? " isn't" : "s aren't"} linked yet. They’ll import but show as “not matched”.</p>}
              {!built.hasPayment && (
                <div className="row" style={{ marginTop: 8 }}>
                  <div><label htmlFor="imp-cash">Cash sales on the till report (R)</label><input id="imp-cash" type="number" inputMode="decimal" min="0" step="0.01" value={cash} onChange={(e) => setCash(e.target.value)} /></div>
                  <div><label htmlFor="imp-card">Card sales (R)</label><input id="imp-card" type="number" inputMode="decimal" min="0" step="0.01" value={card} onChange={(e) => setCard(e.target.value)} /></div>
                </div>
              )}
              {!built.hasPayment && <p className="small muted">This file doesn’t say how each sale was paid, so enter the cash and card totals from the till’s end-of-day report.</p>}
              <button type="button" style={{ marginTop: 10 }} disabled={pending || built.lines.length === 0} onClick={doImport}>
                {pending ? "Importing…" : "Import sales"}
              </button>
            </div>
          )}
        </>
      )}
      {result?.error && <p className="notice error" role="alert">{result.error}</p>}
      {result?.ok && <p className="notice ok" role="status">{result.ok}</p>}
    </div>
  );
}
