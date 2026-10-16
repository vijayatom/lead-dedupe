import { head, list, put } from "@vercel/blob";
import { promises as fs } from "fs";
import path from "path";

// Storage:
// - BLOB_READ_WRITE_TOKEN set (Vercel prod/preview, or local via `vercel env pull`):
//   durable Vercel Blob store shared by every deployment.
// - Otherwise (fresh local dev): JSON file at data/db.json.

const EMAILS_KEY = "lead-dedupe/emails.json";
const CAMPAIGNS_KEY = "lead-dedupe/campaigns.json";
const DB_FILE = path.join(process.cwd(), "data", "db.json");

type Campaign = {
  name: string;
  total_rows: number;
  new_count: number;
  dup_count: number;
  created_at: string;
};

function useBlob() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Reads a blob, or throws.
 *
 * CRITICAL: this used to swallow every error and return `fallback` ({}). Since
 * `commitEmails` does read-modify-write on the whole email map, a transient
 * read failure would return {} and then overwrite the store with only the new
 * rows — destroying every existing email. A missing key still returns the
 * fallback, but a *failed read* must never be indistinguishable from empty.
 */
async function readBlob<T>(key: string, fallback: T): Promise<T> {
  const blobs = await list({ prefix: key });
  const hit = blobs.blobs.find((b) => b.pathname === key);
  if (!hit) return fallback;
  // Private blobs need auth on read: signed downloadUrl alone 403s from
  // some networks, so always send the RW token when we have it.
  const headers: Record<string, string> = {};
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`;
  }
  const res = await fetch(hit.downloadUrl || hit.url, {
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Blob read failed for ${key}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * readBlob returns `{}` both when the key is legitimately absent and when the
 * payload is corrupt. Committing against that would wipe the store, so a
 * read-modify-write refuses to proceed on a non-object payload.
 */
function asStore(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Email store is not a valid object — refusing to overwrite it.");
  }
  return value as Record<string, string>;
}

async function writeBlob(key: string, value: unknown) {
  await put(key, JSON.stringify(value), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

type LocalDB = { emails: Record<string, string>; campaigns: Campaign[] };

async function readLocal(): Promise<LocalDB> {
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    const j = JSON.parse(raw);
    return { emails: j.emails ?? {}, campaigns: j.campaigns ?? [] };
  } catch {
    return { emails: {}, campaigns: [] };
  }
}

async function writeLocal(db: LocalDB) {
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(db));
}

export async function ensureSchema() {
  if (!useBlob()) return;
  // Existence check only — never overwrite. (A failed read must not wipe data.)
  const { blobs } = await list({ prefix: "lead-dedupe/" });
  const names = new Set(blobs.map((b) => b.pathname));
  if (!names.has(EMAILS_KEY)) await writeBlob(EMAILS_KEY, {});
  if (!names.has(CAMPAIGNS_KEY)) await writeBlob(CAMPAIGNS_KEY, []);
}

export async function checkEmails(
  emails: string[]
): Promise<{ email: string; campaign: string }[]> {
  const uniq = Array.from(new Set(emails.map((e) => e.toLowerCase())));
  if (uniq.length === 0) return [];
  if (useBlob()) {
    const store = asStore(await readBlob<unknown>(EMAILS_KEY, {}));
    return uniq
      .filter((e) => e in store)
      .map((e) => ({ email: e, campaign: store[e] }));
  }
  const db = await readLocal();
  return uniq
    .filter((e) => e in db.emails)
    .map((e) => ({ email: e, campaign: db.emails[e] }));
}

export async function commitEmails(
  entries: { email: string; campaign: string }[],
  campaignName: string,
  totalRows: number,
  dupCount: number
): Promise<{ inserted: number }> {
  const uniq = new Map<string, string>();
  for (const e of entries) {
    const k = e.email.toLowerCase();
    if (!uniq.has(k)) uniq.set(k, e.campaign);
  }
  const record: Campaign = {
    name: campaignName,
    total_rows: totalRows,
    new_count: 0,
    dup_count: dupCount,
    created_at: new Date().toISOString(),
  };
  if (useBlob()) {
    // Read first. If this throws, we never reach writeBlob — that is the whole
    // point: a failed read must not be able to truncate the store.
    const store = asStore(await readBlob<unknown>(EMAILS_KEY, {}));
    let inserted = 0;
    for (const [email, campaign] of Array.from(uniq.entries())) {
      if (!(email in store)) {
        store[email] = campaign;
        inserted++;
      }
    }
    await writeBlob(EMAILS_KEY, store);
    record.new_count = inserted;
    const camps = await readBlob<Campaign[]>(CAMPAIGNS_KEY, []);
    camps.push(record);
    await writeBlob(CAMPAIGNS_KEY, camps);
    return { inserted };
  }
  const db = await readLocal();
  let inserted = 0;
  for (const [email, campaign] of Array.from(uniq.entries())) {
    if (!(email in db.emails)) {
      db.emails[email] = campaign;
      inserted++;
    }
  }
  record.new_count = inserted;
  db.campaigns.push(record);
  await writeLocal(db);
  return { inserted };
}

export async function getStats() {
  if (useBlob()) {
    const [raw, camps] = await Promise.all([
      readBlob<unknown>(EMAILS_KEY, {}),
      readBlob<Campaign[]>(CAMPAIGNS_KEY, []),
    ]);
    const store = asStore(raw);
    return {
      totalEmails: Object.keys(store).length,
      campaigns: [...camps].reverse().slice(0, 20),
      connected: true,
    };
  }
  const db = await readLocal();
  return {
    totalEmails: Object.keys(db.emails).length,
    campaigns: [...db.campaigns].reverse().slice(0, 20),
    connected: false,
  };
}
