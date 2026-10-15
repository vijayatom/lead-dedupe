// Seeds the Blob store from data/seed-emails.json.
// Usage: `vercel env pull .env.local` once, then `npm run seed`.
// Idempotent: only inserts emails not already stored.
import { readFileSync } from "fs";
import { list, put } from "@vercel/blob";

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error("Set BLOB_READ_WRITE_TOKEN first (run: vercel env pull .env.local).");
  process.exit(1);
}

const seed = JSON.parse(readFileSync(new URL("../data/seed-emails.json", import.meta.url), "utf8"));
console.log(`Seed file: ${seed.length} emails`);

const KEY = "lead-dedupe/emails.json";
const CAMPS = "lead-dedupe/campaigns.json";

async function readJson(key, fallback) {
  const { blobs } = await list({ prefix: key });
  const hit = blobs.find((b) => b.pathname === key);
  if (!hit) return fallback;
  const headers = {};
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`;
  }
  const res = await fetch(hit.downloadUrl || hit.url, { headers });
  if (!res.ok) throw new Error(`read ${key}: HTTP ${res.status}`);
  return await res.json();
}

const store = await readJson(KEY, {});
const before = Object.keys(store).length;
let added = 0;
for (const e of seed) {
  const k = String(e.email).toLowerCase();
  if (!(k in store)) {
    store[k] = e.campaign;
    added++;
  }
}
await put(KEY, JSON.stringify(store), {
  access: "private",
  contentType: "application/json",
  addRandomSuffix: false,
  allowOverwrite: true,
});
const camps = await readJson(CAMPS, []);
camps.push({
  name: "seed-import",
  total_rows: seed.length,
  new_count: added,
  dup_count: seed.length - added,
  created_at: new Date().toISOString(),
});
await put(CAMPS, JSON.stringify(camps), {
  access: "private",
  contentType: "application/json",
  addRandomSuffix: false,
  allowOverwrite: true,
});
console.log(`Done. Added ${added} new. Total in store: ${Object.keys(store).length} (was ${before})`);
