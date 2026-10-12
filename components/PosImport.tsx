"use client";

// Import a sales export from any till (CSV or Excel). OnPoint works out the
// columns and links the till's items to your products; you confirm anything
// it isn't sure about once, and it remembers for next time.
import { useMemo, useState, useTransition } from "react";
import Papa from "papaparse";
import { sha256Hex } from "@/lib/pos/csv";
import {
  FIELDS, buildLines, cellText, collectItems, detectDelimiter, findHeaderRow, guessMapping, linkItems, mlFromName, sizeFromName,
  type Field, type Layout, type Mapping, type Product,
} from "@/lib/pos/smart";
import { importPos, savePosLayout, saveTillTotals } from "@/app/actions";
import { getLoyverseSales } from "@/app/pos-actions";
import { formatZar } from "@/lib/calculations";
import { TOT_ML } from "@/lib/bottles";

type Item = { key: string; code: string; name: string; count: number };
const SKIP = "__skip__";

export function PosImport({ shiftId, products, layout, loyverse = false }: { shiftId: string; products: Product[]; layout: Layout; loyverse?: boolean }) {
  const [fileName, setFileName] = useState("");
  const [hash, setHash] = useState("");
  const tag = hash.slice(0, 12);
  const [rows, setRows] = useState<string[][]>([]);
  const [header, setHeader] = useState(0);
  const [mapping, setMapping] = useState<Mapping>({});
  const [showMap, setShowMap] = useState(false);
  const [links, setLinks] = useState<Record<string, string>>(layout.links ?? {});
  const [skip, setSkip] = useState<string[]>(layout.skip ?? []);
  const [sizes, setSizes] = useState<Record<string, number>>(layout.sizes ?? {});
  const [items, setItems] = useState<Item[]>([]);
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
    setItems(items);
    // Suggest bag sizes from names like "Gelato 2g" (only for new items)
    setSizes((prev) => {
      const next = { ...prev };
      for (const it of items) if (next[it.key] === undefined) { const g = sizeFromName(it.name || it.code); if (g && g !== 1) next[it.key] = g; }
      return next;
    });
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
        setReadError("This is an older Excel file (.xls). Save it as .xlsx or CSV, then upload it again.");
        return;
      } else {
        const text = (await f.text()).replace(/^\uFEFF/, "");
        data = Papa.parse<string[]>(text.trim(), { delimiter: detectDelimiter(text), skipEmptyLines: false }).data;
      }
      data = data.map((r) => r.map((c) => (c ?? "").toString()));
      loadRows(data, await sha256Hex(JSON.stringify(data)));
    } catch {
      setReadError("We couldn’t read this file. Save it as CSV or Excel (.xlsx) from your till and try again.");
    }
  }

  function loadRows(data: string[][], sha: string) {
    setHash(sha);
    const h = findHeaderRow(data);
    const g = guessMapping(data[h] ?? [], layout.columns);
    setRows(data); setHeader(h); setMapping(g.mapping); setShowMap(!g.sure);
    relink(g.mapping, data.slice(h + 1));
  }

  // Loyverse: fetch this shift's receipts and review them like a till file
  const [lvBusy, setLvBusy] = useState(false);
  async function fromLoyverse() {
    setResult(undefined); setReadError(""); setRows([]); setToLink([]); setLvBusy(true);
    const r = await getLoyverseSales(shiftId);
    setLvBusy(false);
    if (r.error || !r.rows) { setReadError(r.error ?? "Nothing to bring in."); return; }
    setFileName(r.fileName ?? "Loyverse");
    loadRows(r.rows, r.sha256!);
  }

  function setField(f: Field, v: string) {
    const m = { ...mapping };
    if (v === "") delete m[f]; else m[f] = Number(v);
    setMapping(m);
    if (f === "code" || f === "name") relink(m, body);
  }

  // Spirits are kept in ml, so a till sale of one tot is 25 ml unless set otherwise
  const mlIds = useMemo(() => new Set(products.filter((p) => p.base_unit === "ml").map((p) => p.id)), [products]);
  const effSizes = useMemo(() => {
    const x = { ...sizes };
    for (const it of items) if (links[it.key] && mlIds.has(links[it.key]) && x[it.key] === undefined) x[it.key] = mlFromName(it.name || it.code) ?? TOT_ML;
    return x;
  }, [sizes, items, links, mlIds]);
  const built = useMemo(
    () => (rows.length ? buildLines(body, mapping, links, skip, products, new Date(), tag, effSizes) : null),
    [rows.length, body, mapping, links, skip, products, tag, effSizes],
  );
  const missing = FIELDS.filter((f) => f.required && mapping[f.key] === undefined).length > 0
    || (mapping.name === undefined && mapping.code === undefined)
    || (mapping.amount === undefined && mapping.price === undefined);
  const open = toLink.filter((it) => !links[it.key] && !skip.includes(it.key));
  const weighed = new Set(products.filter((p) => p.base_unit === "g" || p.base_unit === "ml").map((p) => p.id));
  const bagItems = items.filter((it) => links[it.key] && weighed.has(links[it.key]) && !skip.includes(it.key));
  const sample = (i: number | undefined) => (i === undefined ? "" : body.find((r) => r[i])?.[i] ?? "");

  function doImport() {
    if (!built) return;
    start(async () => {
      const columns = Object.fromEntries(Object.entries(mapping).map(([f, i]) => [f, headers[i as number]]));
      const saved = await savePosLayout({ columns, links, skip, sizes: effSizes });
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
      {loyverse && (
        <div style={{ marginBottom: 12 }}>
          <button type="button" onClick={fromLoyverse} disabled={lvBusy} style={{ width: "100%" }}>{lvBusy ? "Getting sales…" : "Get sales from Loyverse"}</button>
          <p className="small muted" style={{ margin: "6px 0 0" }}>Brings in every sale and refund since this shift opened. Tap again later for newer sales; nothing is counted twice. Or upload a file below.</p>
        </div>
      )}
      <label htmlFor="pos-file">
        Upload today’s till sales <span className="hint">Upload the sales report from your till in CSV or Excel format.</span>
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
              <p style={{ marginTop: 0 }}><strong>Match the columns in your file.</strong> OnPoint will remember your choices for next time.</p>
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
              {missing && <p className="notice" role="status">Choose the product, quantity and line total or unit price.</p>}
              {!missing && <button type="button" onClick={() => setShowMap(false)}>Done</button>}
            </div>
          )}

          {/* Items not yet linked to a product */}
          {!missing && open.length > 0 && (
            <div className="sheet" style={{ marginTop: 12 }}>
              <p style={{ marginTop: 0 }}><strong>Which OnPoint product matches this item?</strong> {open.length === 1 ? "1 item still needs" : `${open.length} items still need`} matching. We’ll remember your choices.</p>
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
                      <option value={SKIP}>Not stock we count</option>
                    </select>
                  </li>
                ))}
              </ul>
              {open.length > 40 && <p className="small muted">…and {open.length - 40} more. Link these first, then the rest appear.</p>}
            </div>
          )}

          {/* Fixed bags on weighed products */}
          {!missing && bagItems.length > 0 && (
            <details className="sheet" style={{ marginTop: 12 }} open={bagItems.some((it) => layout.sizes?.[it.key] === undefined && sizes[it.key] !== undefined)}>
              <summary><strong>Amount in each sale</strong> <span className="small muted">for flower sold in fixed bags, and spirits sold by the tot</span></summary>
              <p className="small muted">If your till records “2 g for R50”, enter 2 g: three sales then count as 6 g sold. Spirits start at 25 ml a tot; change it for doubles or bottles. Leave grams as 1 if your till already records grams.</p>
              <ul className="lines">
                {bagItems.map((it) => (
                  <li key={it.key} className="line">
                    <span className="name" style={{ margin: 0 }}>{it.name || it.code}</span>
                    <input aria-label={`${mlIds.has(links[it.key]) ? "ml" : "Grams"} in each sale of ${it.name || it.code}`} inputMode="decimal" style={{ width: 90 }}
                      defaultValue={String(effSizes[it.key] ?? 1)}
                      onChange={(e) => {
                        const n = Number(e.target.value.replace(",", "."));
                        setSizes((s) => { const x = { ...s }; if (n > 0 && (n !== 1 || mlIds.has(links[it.key]))) x[it.key] = n; else delete x[it.key]; return x; });
                      }} /> {mlIds.has(links[it.key]) ? "ml" : "g"}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* Check and import */}
          {!missing && built && (
            <div className="sheet" style={{ background: "var(--paper)", marginTop: 12 }}>
              <p style={{ margin: 0 }}>
                {built.lines.length} sales lines · {formatZar(built.totals.sales)} sales{Number(built.totals.refunds) ? `, refunds ${formatZar(built.totals.refunds)}` : ""}.
                {built.hasPayment && Object.keys(built.byMethod).length > 0 && <> ({Object.entries(built.byMethod).map(([m, v]) => `${m} ${formatZar(v)}`).join(", ")})</>}
                {built.skipped > 0 && <> · {built.skipped} non-stock line{built.skipped === 1 ? "" : "s"} skipped</>}
              </p>
              {built.errors.length > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary className="small">{built.errors.length} row{built.errors.length === 1 ? "" : "s"} couldn’t be read</summary>
                  <ul className="small" style={{ paddingLeft: 18 }}>{built.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}</ul>
                </details>
              )}
              {open.length > 0 && <p className="small" style={{ color: "var(--variance)" }}>{open.length} item{open.length === 1 ? "" : "s"} still need{open.length === 1 ? "s" : ""} matching. They’ll upload but show as “not matched”.</p>}
              {!built.hasPayment && (
                <div className="row" style={{ marginTop: 8 }}>
                  <div><label htmlFor="imp-cash">Cash sales (R)</label><input id="imp-cash" type="number" inputMode="decimal" min="0" step="0.01" value={cash} onChange={(e) => setCash(e.target.value)} /></div>
                  <div><label htmlFor="imp-card">Card sales (R)</label><input id="imp-card" type="number" inputMode="decimal" min="0" step="0.01" value={card} onChange={(e) => setCard(e.target.value)} /></div>
                </div>
              )}
              {!built.hasPayment && <p className="small muted">This file doesn’t show how customers paid. Enter the cash and card totals from your till’s end-of-day report.</p>}
              <button type="button" style={{ marginTop: 10 }} disabled={pending || built.lines.length === 0} onClick={doImport}>
                {pending ? "Uploading…" : "Upload sales"}
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
