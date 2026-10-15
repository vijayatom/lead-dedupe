// Shared email helpers — identical logic runs in the browser (detection +
// row splitting) and on the server (seed script). Keep in sync.

// Strict enough to reject status flags like "ok", "valid", "risk".
export const EMAIL_RX = /^[^@\s,;]+@[^@\s,;]+\.[A-Za-z]{2,}$/;

export function normalizeEmail(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  return EMAIL_RX.test(s) ? s : null;
}

/**
 * Content-based column detection: score every column by the fraction of
 * non-blank values that look like real emails. The winner is the email
 * column regardless of its header name ("Email", "business_email", ...).
 * Columns like email_status ("ok") score 0 and are rejected.
 */
export function detectEmailColumn(
  headers: string[],
  rows: Record<string, unknown>[],
  sampleSize = 500
): { index: number; header: string } | null {
  const sample = rows.slice(0, sampleSize);
  if (sample.length === 0) return null;
  let bestIndex = -1;
  let bestHeader = "";
  let bestRatio = -1;
  headers.forEach((h, i) => {
    let blank = 0;
    let hits = 0;
    for (const r of sample) {
      const v = r[h];
      if (v === null || v === undefined || String(v).trim() === "") {
        blank++;
        continue;
      }
      if (EMAIL_RX.test(String(v).trim())) hits++;
    }
    const nonBlank = sample.length - blank;
    if (nonBlank === 0) return;
    const ratio = hits / nonBlank;
    if (hits > 0 && ratio > bestRatio) {
      bestIndex = i;
      bestHeader = h;
      bestRatio = ratio;
    }
  });
  return bestIndex >= 0 ? { index: bestIndex, header: bestHeader } : null;
}
