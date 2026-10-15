import { Client } from "@neondatabase/serverless";
import { promises as fs } from "fs";
import path from "path";

// Storage abstraction:
// - Production (DATABASE_URL set, i.e. Neon connected): Postgres.
// - Local dev without DATABASE_URL: JSON file at data/db.json.
// Prod refuses to run without DATABASE_URL so leads are never silently lost.

const DB_FILE = path.join(process.cwd(), "data", "db.json");

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS emails (
    email TEXT PRIMARY KEY,
    campaign TEXT NOT NULL DEFAULT 'seed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    total_rows INT NOT NULL DEFAULT 0,
    new_count INT NOT NULL DEFAULT 0,
    dup_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_emails_created ON emails (created_at DESC)`,
];

type LocalDB = { emails: Record<string, string>; campaigns: unknown[] };

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

function usePostgres() {
  return !!process.env.DATABASE_URL;
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client(process.env.DATABASE_URL!);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function ensureSchema() {
  if (!usePostgres()) return;
  await withClient(async (c) => {
    for (const stmt of SCHEMA) await c.query(stmt);
  });
}

export async function checkEmails(
  emails: string[]
): Promise<{ email: string; campaign: string }[]> {
  const uniq = Array.from(new Set(emails.map((e) => e.toLowerCase())));
  if (uniq.length === 0) return [];
  if (usePostgres()) {
    return withClient(async (c) => {
      // chunk to stay under parameter limits
      const out: { email: string; campaign: string }[] = [];
      for (let i = 0; i < uniq.length; i += 1000) {
        const batch = uniq.slice(i, i + 1000);
        const { rows } = await c.query(
          "SELECT email, campaign FROM emails WHERE email = ANY($1)",
          [batch]
        );
        out.push(...(rows as { email: string; campaign: string }[]));
      }
      return out;
    });
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
  const list = Array.from(uniq.entries());
  if (usePostgres()) {
    return withClient(async (c) => {
      let inserted = 0;
      for (let i = 0; i < list.length; i += 500) {
        const batch = list.slice(i, i + 500);
        const values = batch
          .map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`)
          .join(", ");
        const params = batch.flatMap(([email, campaign]) => [email, campaign]);
        const res = await c.query(
          `INSERT INTO emails (email, campaign) VALUES ${values} ON CONFLICT (email) DO NOTHING`,
          params
        );
        inserted += res.rowCount ?? 0;
      }
      await c.query(
        "INSERT INTO campaigns (name, total_rows, new_count, dup_count) VALUES ($1, $2, $3, $4)",
        [campaignName, totalRows, inserted, dupCount]
      );
      return { inserted };
    });
  }
  const db = await readLocal();
  let inserted = 0;
  for (const [email, campaign] of list) {
    if (!(email in db.emails)) {
      db.emails[email] = campaign;
      inserted++;
    }
  }
  (db.campaigns as unknown[]).push({
    name: campaignName,
    total_rows: totalRows,
    new_count: inserted,
    dup_count: dupCount,
    created_at: new Date().toISOString(),
  });
  await writeLocal(db);
  return { inserted };
}

export async function getStats() {
  if (usePostgres()) {
    return withClient(async (c) => {
      const total = await c.query("SELECT COUNT(*)::int AS c FROM emails");
      let campaigns: unknown[] = [];
      try {
        const r = await c.query(
          "SELECT name, total_rows, new_count, dup_count, created_at FROM campaigns ORDER BY created_at DESC LIMIT 20"
        );
        campaigns = r.rows;
      } catch {
        campaigns = [];
      }
      return {
        totalEmails: (total.rows[0] as { c: number }).c,
        campaigns,
        postgres: true,
      };
    });
  }
  const db = await readLocal();
  return {
    totalEmails: Object.keys(db.emails).length,
    campaigns: (db.campaigns as unknown[]).slice(-20).reverse(),
    postgres: false,
  };
}
