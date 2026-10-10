"use client";

import { useState, useTransition } from "react";
import { parsePosCsv, type ParseResult } from "@/lib/pos/csv";
import { importPos } from "@/app/actions";
import { formatZar } from "@/lib/calculations";

export function PosImport({ shiftId }: { shiftId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [result, setResult] = useState<{ error?: string; ok?: string } | undefined>();
  const [pending, start] = useTransition();

  async function onFile(f: File | null) {
    setResult(undefined);
    setFile(f);
    setParsed(f ? await parsePosCsv(await f.text()) : null);
  }

  return (
    <div>
      <label htmlFor="pos-file">
        POS export (CSV) <span className="hint"><a href="/sample-pos-export.csv" download>See the expected format</a></span>
      </label>
      <input id="pos-file" type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />

      {parsed && parsed.errors.length > 0 && (
        <div className="notice error" role="alert">
          <strong>Fix these rows in the export, then choose the file again:</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {parsed.errors.slice(0, 12).map((e) => <li key={e}>{e}</li>)}
            {parsed.errors.length > 12 && <li>…and {parsed.errors.length - 12} more</li>}
          </ul>
        </div>
      )}

      {parsed && parsed.errors.length === 0 && (
        <div className="sheet" style={{ background: "var(--paper)" }}>
          <p style={{ margin: 0 }}>
            {parsed.lines.length} lines checked. Sales {formatZar(parsed.totals.sales)}, refunds {formatZar(parsed.totals.refunds)}.
          </p>
          <button
            type="button"
            style={{ marginTop: 10 }}
            disabled={pending}
            onClick={() =>
              start(async () => {
                setResult(await importPos({ shiftId, fileName: file?.name ?? "pos.csv", sha256: parsed.sha256, totals: parsed.totals, lines: parsed.lines }));
              })
            }
          >
            {pending ? "Importing…" : "Import sales"}
          </button>
        </div>
      )}
      {result?.error && <p className="notice error" role="alert">{result.error}</p>}
      {result?.ok && <p className="notice ok" role="status">{result.ok}</p>}
    </div>
  );
}
