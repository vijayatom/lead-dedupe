"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import { detectEmailColumn, normalizeEmail } from "@/lib/email";

type Row = Record<string, string>;
type Dup = { email: string; campaign: string };

type Phase = "idle" | "parsing" | "checking" | "done" | "error";

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [emailCol, setEmailCol] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [scanned, setScanned] = useState(0);
  const [noEmail, setNoEmail] = useState(0);
  const [dups, setDups] = useState<Dup[]>([]);
  const [newRows, setNewRows] = useState<Row[]>([]);
  const [newEmails, setNewEmails] = useState<string[]>([]);
  const [committed, setCommitted] = useState<number | null>(null);
  const [committing, setCommitting] = useState(false);
  const [dbTotal, setDbTotal] = useState<number | null>(null);
  const [dbOk, setDbOk] = useState<boolean | null>(null);
  const [dragHot, setDragHot] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((j) => {
        setDbTotal(typeof j.totalEmails === "number" ? j.totalEmails : 0);
        // Local dev uses a JSON file (fine). On a deployed URL, only the Blob store counts.
        const h = window.location.hostname;
        const isLocal = h === "localhost" || h === "127.0.0.1";
        setDbOk(j.connected === false ? false : isLocal ? true : j.connected !== false);
      })
      .catch(() => setDbOk(false));
  }, []);

  const reset = () => {
    setPhase("idle");
    setError("");
    setFileName("");
    setDups([]);
    setNewRows([]);
    setNewEmails([]);
    setCommitted(null);
  };

  const handleFile = useCallback((file: File) => {
    reset();
    setFileName(file.name);
    setPhase("parsing");
    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: true,
      encoding: "utf-8",
      complete: async (results) => {
        try {
          const rows = (results.data as Row[]).filter((r) =>
            Object.values(r).some((v) => v !== null && v !== undefined && String(v).trim() !== "")
          );
          const hdrs = results.meta.fields ?? [];
          if (rows.length === 0) {
            setError("No data rows found in this CSV.");
            setPhase("error");
            return;
          }
          const detected = detectEmailColumn(hdrs, rows);
          if (!detected) {
            setError("No email column found — no column holds email addresses.");
            setPhase("error");
            return;
          }
          setEmailCol(detected.header);
          setHeaders(hdrs);
          setScanned(rows.length);

          // extract email per row
          const rowEmail: (string | null)[] = rows.map((r) =>
            normalizeEmail(r[detected.header])
          );
          setNoEmail(rowEmail.filter((e) => !e).length);
          const uniq = [...new Set(rowEmail.filter((e): e is string => !!e))];

          setPhase("checking");
          const res = await fetch("/api/check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ emails: uniq }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.error || "Database lookup failed.");
          }
          const { existing } = (await res.json()) as { existing: Dup[] };
          const existSet = new Set(existing.map((e) => e.email.toLowerCase()));
          const existByEmail = new Map(
            existing.map((e) => [e.email.toLowerCase(), e.campaign])
          );
          const dupList: Dup[] = [];
          const freshRows: Row[] = [];
          const freshEmails: string[] = [];
          const seenNew = new Set<string>();
          rows.forEach((r, i) => {
            const e = rowEmail[i];
            if (!e) return; // skipped, counted above
            if (existSet.has(e)) {
              if (!dupList.some((d) => d.email === e))
                dupList.push({ email: e, campaign: existByEmail.get(e) ?? "" });
            } else if (!seenNew.has(e)) {
              seenNew.add(e);
              freshRows.push(r);
              freshEmails.push(e);
            } else {
              // duplicate within the uploaded file itself -> also a dup
              if (!dupList.some((d) => d.email === e))
                dupList.push({ email: e, campaign: "this file" });
            }
          });
          setDups(dupList);
          setNewRows(freshRows);
          setNewEmails(freshEmails);
          setPhase("done");
        } catch (err) {
          setError(err instanceof Error ? err.message : "Something went wrong.");
          setPhase("error");
        }
      },
      error: (err) => {
        setError("Could not parse CSV: " + err.message);
        setPhase("error");
      },
    });
  }, []);

  const download = async () => {
    if (newRows.length === 0) return;
    // Build CSV client-side: duplicates removed, rows closed up, all columns kept.
    const csv = Papa.unparse(newRows, { columns: headers });
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const base = fileName.replace(/\.csv$/i, "") || "leads";
    a.href = url;
    a.download = `${base}-new.csv`;
    a.click();
    URL.revokeObjectURL(url);
    // Save new leads to DB on download.
    setCommitting(true);
    try {
      const res = await fetch("/api/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emails: newEmails.map((e) => ({ email: e, campaign: base })),
          campaign: base,
          totalRows: scanned,
          dupCount: dups.length,
        }),
      });
      const j = await res.json();
      setCommitted(typeof j.inserted === "number" ? j.inserted : newEmails.length);
      const s = await fetch("/api/stats").then((r) => r.json());
      if (typeof s.totalEmails === "number") setDbTotal(s.totalEmails);
    } catch {
      setCommitted(newEmails.length);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <main style={S.main}>
      <div style={S.wrap}>
        <h1 style={S.h1}>Lead Dedupe</h1>
        <p style={S.sub}>
          Upload a CSV &rarr; see which emails are already in the database &rarr; download
          only the new leads.{" "}
          {dbTotal !== null && (
            <span style={{ color: "#7dd3fc" }}>{dbTotal.toLocaleString()} emails in DB</span>
          )}
          {dbOk === false && (
            <span style={{ color: "#fbbf24" }}> — database not connected yet</span>
          )}
        </p>

        <section style={S.card}>
          <h2 style={S.h2}>1 · Upload</h2>
          <div
            style={{ ...S.drop, ...(dragHot ? S.dropHot : null) }}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragHot(true);
            }}
            onDragLeave={() => setDragHot(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragHot(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
          >
            <div style={S.dropBig}>Drop your CSV here — or click to choose</div>
            <div style={S.dropSmall}>Any email column name works. Detected automatically.</div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          {fileName && <div style={S.fileRow}>File: {fileName}</div>}
        </section>

        {(phase === "parsing" || phase === "checking") && (
          <section style={S.card}>
            <div style={{ fontSize: 14 }}>
              {phase === "parsing" ? "Reading CSV…" : `Checking ${scanned.toLocaleString()} emails against the database…`}
            </div>
          </section>
        )}

        {phase === "error" && (
          <section style={{ ...S.card, borderColor: "#7f1d1d" }}>
            <div style={{ color: "#fca5a5", fontSize: 14 }}>{error}</div>
          </section>
        )}

        {phase === "done" && (
          <>
            <section style={S.card}>
              <h2 style={S.h2}>
                2 · Results {emailCol && <span style={{ textTransform: "none" }}>— email column: {emailCol}</span>}
              </h2>
              <div style={S.stats}>
                <Stat n={scanned} l="Rows scanned" c="#e6e8eb" />
                <Stat n={dups.length} l="Already in DB" c="#f87171" />
                <Stat n={newRows.length} l="New leads" c="#4ade80" />
                <Stat n={noEmail} l="No email — skipped" c="#fbbf24" />
              </div>
              <div style={S.panels}>
                <div style={S.panel}>
                  <div style={{ ...S.ph, borderLeft: "3px solid #ef4444" }}>
                    <span>Already in database</span>
                    <span style={{ ...S.cnt, background: "#3a1d20", color: "#fca5a5" }}>
                      {dups.length}
                    </span>
                  </div>
                  <div style={S.list}>
                    {dups.length === 0 && <div style={S.empty}>None — all fresh.</div>}
                    {dups.slice(0, 500).map((d) => (
                      <div style={S.row} key={d.email}>
                        <span style={S.em}>{d.email}</span>
                        <span style={S.tag}>{d.campaign}</span>
                      </div>
                    ))}
                    {dups.length > 500 && (
                      <div style={S.empty}>… {dups.length - 500} more</div>
                    )}
                  </div>
                </div>
                <div style={S.panel}>
                  <div style={{ ...S.ph, borderLeft: "3px solid #22c55e" }}>
                    <span>New leads</span>
                    <span style={{ ...S.cnt, background: "#16301f", color: "#86efac" }}>
                      {newRows.length}
                    </span>
                  </div>
                  <div style={S.list}>
                    {newRows.length === 0 && <div style={S.empty}>Nothing new.</div>}
                    {newEmails.slice(0, 500).map((e) => (
                      <div style={S.row} key={e}>
                        <span style={S.em}>{e}</span>
                      </div>
                    ))}
                    {newEmails.length > 500 && (
                      <div style={S.empty}>… {newEmails.length - 500} more</div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section style={S.card}>
              <h2 style={S.h2}>3 · Download</h2>
              <div style={S.btns}>
                <button style={S.btnP} onClick={download} disabled={committing || newRows.length === 0}>
                  {committing
                    ? "Saving…"
                    : `Download ${newRows.length.toLocaleString()} new leads (CSV)`}
                </button>
                <button style={S.btnS} onClick={reset}>
                  Upload another file
                </button>
              </div>
              {committed !== null && (
                <div style={{ ...S.note, color: "#4ade80" }}>
                  Saved {committed.toLocaleString()} new leads to the database.
                </div>
              )}
              <div style={S.note}>
                Duplicate rows are deleted and remaining rows shift up — no blank gaps. All
                original columns are kept. New leads are saved to the database when you
                download.
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function Stat({ n, l, c }: { n: number; l: string; c: string }) {
  return (
    <div style={S.stat}>
      <div style={{ ...S.statN, color: c }}>{n.toLocaleString()}</div>
      <div style={S.statL}>{l}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: {
    background: "#0f1115",
    color: "#e6e8eb",
    minHeight: "100vh",
    padding: 32,
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    lineHeight: 1.5,
  },
  wrap: { maxWidth: 1180, margin: "0 auto" },
  h1: { fontSize: 24, fontWeight: 650, letterSpacing: "-0.02em", margin: 0 },
  sub: { color: "#8b93a1", fontSize: 13, marginTop: 4, marginBottom: 28 },
  card: {
    background: "#171a21",
    border: "1px solid #232733",
    borderRadius: 12,
    padding: 22,
    marginBottom: 18,
  },
  h2: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.09em",
    color: "#8b93a1",
    marginBottom: 16,
    fontWeight: 600,
    marginTop: 0,
  },
  drop: {
    border: "2px dashed #2e3441",
    borderRadius: 10,
    padding: "44px 20px",
    textAlign: "center",
    background: "#12151b",
    cursor: "pointer",
  },
  dropHot: { borderColor: "#3b82f6", background: "#141b26" },
  dropBig: { fontSize: 15, fontWeight: 550, marginBottom: 6 },
  dropSmall: { fontSize: 12.5, color: "#8b93a1" },
  fileRow: { fontSize: 12.5, color: "#8b93a1", marginTop: 10 },
  stats: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 18 },
  stat: { background: "#12151b", border: "1px solid #232733", borderRadius: 10, padding: "14px 16px" },
  statN: { fontSize: 26, fontWeight: 660, letterSpacing: "-0.02em" },
  statL: { fontSize: 11.5, color: "#8b93a1", marginTop: 2, textTransform: "uppercase", letterSpacing: "0.05em" },
  panels: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 },
  panel: {
    background: "#12151b",
    border: "1px solid #232733",
    borderRadius: 10,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    height: 380,
  },
  ph: {
    padding: "11px 14px",
    borderBottom: "1px solid #232733",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 12.5,
    fontWeight: 600,
  },
  cnt: { fontSize: 11.5, padding: "2px 9px", borderRadius: 20, fontWeight: 650 },
  list: { overflow: "auto", flex: 1 },
  row: {
    padding: "8px 14px",
    borderBottom: "1px solid #191d25",
    fontSize: 12.5,
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center",
  },
  em: {
    fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
    fontSize: 12,
    color: "#c9d1d9",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tag: { fontSize: 10.5, color: "#6b7280", whiteSpace: "nowrap", flexShrink: 0 },
  empty: { padding: "12px 14px", color: "#6b7280", fontSize: 12.5 },
  btns: { display: "flex", gap: 10, marginTop: 18, alignItems: "center", flexWrap: "wrap" },
  btnP: {
    padding: "10px 18px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    border: "1px solid transparent",
    cursor: "pointer",
    background: "#22c55e",
    color: "#04210f",
  },
  btnS: {
    padding: "10px 18px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    background: "#1c2029",
    color: "#c9d1d9",
    border: "1px solid #2e3441",
  },
  note: { fontSize: 12, color: "#6b7280", marginTop: 12 },
};
