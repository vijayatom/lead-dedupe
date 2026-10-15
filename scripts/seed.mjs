// Seeds the database from data/seed-emails.json.
// Usage: DATABASE_URL="postgres://..." npm run seed
import { readFileSync } from "fs";
import { Client } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL first (Neon connection string).");
  process.exit(1);
}

const seed = JSON.parse(readFileSync(new URL("../data/seed-emails.json", import.meta.url), "utf8"));
console.log(`Seeding ${seed.length} emails...`);

const client = new Client(url);
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS emails (
  email TEXT PRIMARY KEY,
  campaign TEXT NOT NULL DEFAULT 'seed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await client.query(`CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, total_rows INT NOT NULL DEFAULT 0,
  new_count INT NOT NULL DEFAULT 0, dup_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

let inserted = 0;
for (let i = 0; i < seed.length; i += 500) {
  const batch = seed.slice(i, i + 500);
  const values = batch.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(", ");
  const params = batch.flatMap((e) => [e.email.toLowerCase(), e.campaign]);
  const res = await client.query(
    `INSERT INTO emails (email, campaign) VALUES ${values} ON CONFLICT (email) DO NOTHING`,
    params
  );
  inserted += res.rowCount ?? 0;
  process.stdout.write(`\r${Math.min(i + 500, seed.length)}/${seed.length}`);
}
await client.query(
  "INSERT INTO campaigns (name, total_rows, new_count, dup_count) VALUES ($1,$2,$3,$4)",
  ["seed-import", seed.length, inserted, seed.length - inserted]
);
const { rows } = await client.query("SELECT COUNT(*)::int AS c FROM emails");
console.log(`\nDone. Inserted ${inserted} new. Total in DB: ${rows[0].c}`);
await client.end();
