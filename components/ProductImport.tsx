"use client";

// Upload a product list (CSV or Excel, any layout) and add it all at once.
import { useMemo, useState, useTransition } from "react";
import Papa from "papaparse";
import { cellText, detectDelimiter } from "@/lib/pos/smart";
import { PFIELDS, buildProducts, findProductHeader, guessProductColumns, type PField } from "@/lib/products/import";
import { importProducts } from "@/app/actions";

export function ProductImport({ existing }: { existing: { name: string; sku: string }[] }) {
  const [rows, setRows] = useState<string[][]>([]);
  const [header, setHeader] = useState(0);
  const [mapping, setMapping] = useState<Partial<Record<PField, number>>>({});
  const [showMap, setShowMap] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ ok?: string; error?: string }>();
  const [pending, start] = useTransition();

  async function onFile(f: File | null) {
    setErr(""); setResult(undefined); setRows([]);
    if (!f) return;
    try {
      let data: string[][];
      if (/\.xlsx$/i.test(f.name)) {
        const { readSheet } = await import("read-excel-file/browser");
        data = (await readSheet(f)).map((r) => r.map(cellText));
      } else if (/\.xls$/i.test(f.name)) {
        setErr("This is an old Excel file (.xls). Save it as .xlsx or CSV and choose it again."); return;
      } else {
        const text = (await f.text()).replace(/^﻿/, "");
        data = Papa.parse<string[]>(text.trim(), { delimiter: detectDelimiter(text) }).data;
      }
      data = data.map((r) => r.map((c) => (c ?? "").toString()));
      const h = findProductHeader(data);
      const g = guessProductColumns(data[h] ?? []);
      setRows(data); setHeader(h); setMapping(g.mapping); setShowMap(!g.sure);
    } catch {
      setErr("This file couldn't be read. Save it as CSV or Excel (.xlsx) and try again.");
    }
  }

  const headers = rows[header] ?? [];
  const built = useMemo(() => (rows.length ? buildProducts(rows.slice(header + 1), mapping, existing) : null), [rows, header, mapping, existing]);
  const ready = mapping.name !== undefined && mapping.price !== undefined;

  return (
    <div className="sheet">
      <h3 style={{ marginTop: 0 }}>Upload your product list</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Upload your product list in CSV or Excel format. Include each product’s name and price. Flower is priced per gram; other products are priced per unit. Existing products are skipped.
      </p>
      <input type="file" aria-label="Product list file" accept=".csv,.txt,.xlsx,.xls" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      {err && <p className="notice error" role="alert">{err}</p>}

      {rows.length > 0 && (
        <>
          {!showMap && ready ? (
            <p className="small" style={{ marginTop: 10 }}>
              Read as: {PFIELDS.filter((f) => mapping[f.key] !== undefined).map((f) => `${f.label} = “${headers[mapping[f.key]!]}”`).join(", ")}.{" "}
              <button type="button" className="quiet" onClick={() => setShowMap(true)}>Change</button>
            </p>
          ) : (
            <div style={{ marginTop: 10 }}>
              <p><strong>Which column is which?</strong></p>
              {PFIELDS.map((f) => (
                <div key={f.key} style={{ marginBottom: 6 }}>
                  <label htmlFor={`pm-${f.key}`}>{f.label}{f.required ? "" : " (if there is one)"}</label>
                  <select id={`pm-${f.key}`} value={mapping[f.key] ?? ""} onChange={(e) => {
                    const m = { ...mapping };
                    if (e.target.value === "") delete m[f.key]; else m[f.key] = Number(e.target.value);
                    setMapping(m);
                  }}>
                    <option value="">Not in this file</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </div>
              ))}
              {ready && <button type="button" onClick={() => setShowMap(false)}>Done</button>}
              {!ready && <p className="notice">Choose the product name and price columns.</p>}
            </div>
          )}

          {ready && built && (
            <>
              <p style={{ marginBottom: 6 }}>
                <strong>{built.items.length} new product{built.items.length === 1 ? "" : "s"}</strong>
                {built.skipped > 0 && `, ${built.skipped} already in your list`}
                {built.errors.length > 0 && `, ${built.errors.length} without a price (left out)`}.
              </p>
              {built.items.length > 0 && (
                <div className="scroll" style={{ maxHeight: 280, overflow: "auto" }}>
                  <table className="data">
                    <thead><tr><th>Product</th><th>Category</th><th>Sold by</th><th className="num">Price</th></tr></thead>
                    <tbody>
                      {built.items.slice(0, 100).map((p) => (
                        <tr key={p.sku}><td>{p.name}<br /><span className="small muted">{p.sku}</span></td><td>{p.category}</td><td>{p.weight ? "gram" : "unit"}</td><td className="num">R{Number(p.price).toFixed(2)}{p.weight ? "/g" : ""}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button type="button" style={{ marginTop: 10 }} disabled={pending || built.items.length === 0}
                onClick={() => start(async () => { setResult(await importProducts(built.items)); setRows([]); })}>
                {pending ? "Adding…" : `Add ${built.items.length} product${built.items.length === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </>
      )}
      {result?.error && <p className="notice error" role="alert">{result.error}</p>}
      {result?.ok && <p className="notice ok" role="status">{result.ok}</p>}
    </div>
  );
}
