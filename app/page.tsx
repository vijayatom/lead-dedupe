"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import { detectEmailColumn, normalizeEmail } from "@/lib/email";

type Row = Record<string, string>;
type Dup = { email: string; campaign: string };

type Phase = "idle" | "parsing" | "checking" | "saving" | "done" | "error";
type SaveState = "idle" | "saving" | "saved" | "error";

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [emailCol, setEmailCol] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [scanned, setScanned] = useState(0);
  const [noEmail, setNoEmail] = useState(0);
  const [dups, setDups] = useState<Dup[]>([]);
  const [dupRows, setDupRows] = useState<Row[]>([]);
  const [newRows, setNewRows] = useState<Row[]>([]);
  const [newEmails, setNewEmails] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [saveError, setSaveError] = useState("");
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
    setDupRows([]);
    setNewRows([]);
    setNewEmails([]);
    setSaveState("idle");
    setSavedCount(null);
    setSaveError("");
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
          const dupRowsOut: Row[] = [];
          const freshRows: Row[] = [];
          const freshEmails: string[] = [];
          const seenNew = new Set<string>();
          // Sets, not Array.some — the old O(n^2) scan stalled on large files.
          const dupSeen = new Set<string>();
          rows.forEach((r, i) => {
            const e = rowEmail[i];
            if (!e) return; // skipped, counted above
            if (existSet.has(e)) {
              // Already in the DB: list it AND keep the original row so it can
              // be exported with all its columns.
              if (!dupSeen.has(e)) {
                dupSeen.add(e);
                dupList.push({ email: e, campaign: existByEmail.get(e) ?? "" });
                dupRowsOut.push(r);
              }
            } else if (!seenNew.has(e)) {
              seenNew.add(e);
              freshRows.push(r);
              freshEmails.push(e);
            } else {
              // duplicate within the uploaded file itself -> also a dup.
              // Not added to dupRowsOut: it was never in the database, so it is
              // not part of the "existing leads" export.
              if (!dupSeen.has(e)) {
                dupSeen.add(e);
                dupList.push({ email: e, campaign: "this file" });
              }
            }
          });
          setDups(dupList);
          setDupRows(dupRowsOut);
          setNewRows(freshRows);
          setNewEmails(freshEmails);

          // Save to the database straight away — not on download.
          setPhase("saving");
          setSaveState("saving");
          // Use file.name, not the `fileName` state: this runs inside a
          // useCallback([]), so the state value would be a stale "" here.
          const base = file.name.replace(/\.csv$/i, "") || "upload";
          try {
            const cr = await fetch("/api/commit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                emails: freshEmails.map((e) => ({ email: e, campaign: base })),
                campaign: base,
                totalRows: rows.length,
                dupCount: dupList.length,
              }),
            });
            const cj = await cr.json().catch(() => ({}));
            if (!cr.ok) throw new Error(cj.error || "Could not save to the database.");
            setSavedCount(typeof cj.inserted === "number" ? cj.inserted : 0);
            setSaveState("saved");
            const s = await fetch("/api/stats").then((r) => r.json());
            if (typeof s.totalEmails === "number") setDbTotal(s.totalEmails);
          } catch (e) {
            // Results stay usable even if the save failed.
            setSaveError(e instanceof Error ? e.message : "Could not save to the database.");
            setSaveState("error");
          }
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

  // Pure client-side CSV export. No DB work — everything is already saved.
  const downloadRows = (rows: Row[], suffix: string) => {
    if (rows.length === 0) return;
    const csv = Papa.unparse(rows, { columns: headers });
    // BOM so Excel opens UTF-8 correctly.
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const base = fileName.replace(/\.csv$/i, "") || "leads";
    a.href = url;
    a.download = `${base}-${suffix}.csv`;
    a.click();
    // Revoke on the next tick; revoking synchronously can abort large files.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadNew = () => downloadRows(newRows, "new");
  const downloadExisting = () => downloadRows(dupRows, "existing");

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

        {(phase === "parsing" || phase === "checking" || phase === "saving") && (
          <section style={S.card}>
            <div style={{ fontSize: 14 }}>
              {phase === "parsing"
                ? "Reading CSV…"
                : phase === "checking"
                ? `Checking ${scanned.toLocaleString()} emails against the database…`
                : "Updating the database…"}
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
                  {dups.length > dupRows.length && (
                    <div style={S.hint}>
                      {dupRows.length.toLocaleString()} already in the database,{" "}
                      {dups.length - dupRows.length} repeated inside this file.
                    </div>
                  )}
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

              {/* DB update notification */}
              {saveState === "saved" && savedCount !== null && (
                <div style={{ ...S.banner, ...S.bannerOk }}>
                  <span style={S.bannerIcon}>✓</span>
                  <span>
                    <strong>Database updated</strong> —{" "}
                    {savedCount === 0
                      ? "0 new leads. Everything in this file was already in the database."
                      : `${savedCount.toLocaleString()} new lead${
                          savedCount === 1 ? "" : "s"
                        } saved from "${fileName}".`}
                  </span>
                </div>
              )}
              {saveState === "error" && (
                <div style={{ ...S.banner, ...S.bannerBad }}>
                  <span style={S.bannerIcon}>!</span>
                  <span>
                    <strong>Database not updated</strong> — {saveError} The results below are
                    still correct, but re-upload this file to save it.
                  </span>
                </div>
              )}

              <div style={S.btns}>
                <button style={S.btnP} onClick={downloadNew} disabled={newRows.length === 0}>
                  Download {newRows.length.toLocaleString()} new leads (CSV)
                </button>
                <button
                  style={S.btnE}
                  onClick={downloadExisting}
                  disabled={dupRows.length === 0}
                >
                  Download {dupRows.length.toLocaleString()} existing leads (CSV)
                </button>
                <button style={S.btnS} onClick={reset}>
                  Upload another file
                </button>
              </div>
              <div style={S.note}>
                Duplicate rows are deleted and remaining rows shift up — no blank gaps. All
                original columns are kept. <strong>New leads are saved to the database as soon
                as you upload</strong> — you do not need to download them.
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
  hint: {
    padding: "9px 14px",
    color: "#8b93a1",
    fontSize: 12,
    background: "#0f1219",
    borderBottom: "1px solid #191d25",
  },
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
  btnE: {
    padding: "10px 18px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    background: "#3a1d20",
    color: "#fca5a5",
    border: "1px solid #7f1d1d",
  },
  banner: {
    display: "flex",
    gap: 11,
    alignItems: "flex-start",
    padding: "12px 14px",
    borderRadius: 10,
    fontSize: 13,
    lineHeight: 1.45,
    marginBottom: 14,
  },
  bannerOk: {
    background: "#10291b",
    border: "1px solid #22c55e",
    color: "#a7f3d0",
  },
  bannerBad: {
    background: "#2a1414",
    border: "1px solid #ef4444",
    color: "#fecaca",
  },
  bannerIcon: {
    flexShrink: 0,
    width: 20,
    height: 20,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 12,
    background: "rgba(255,255,255,0.12)",
  },
  note: { fontSize: 12, color: "#6b7280", marginTop: 12 },
};
