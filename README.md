# Lead Dedupe

Upload a CSV → see which emails are already in the database → download only the new leads.

## How it works

1. Drop a CSV. The email column is **detected by content** (whichever column holds the most valid `name@domain.tld` values wins — `Email`, `business_email`, anything).
2. Each email is trimmed + lowercased and checked against Postgres.
3. Left panel = already in DB (with source campaign). Right panel = new leads.
4. Download returns a CSV with duplicates removed and rows closed up. New leads are saved to the DB on download.

## Run locally

```bash
npm install
npm run dev        # uses data/db.json when DATABASE_URL is missing
```

## Seed

```bash
DATABASE_URL="postgres://..." npm run seed   # loads data/seed-emails.json (13,152 emails)
```

## Deploy (Vercel + Neon)

1. Push to GitHub — Vercel auto-deploys.
2. In the Vercel dashboard: Storage → Create → Neon Postgres → Connect. This injects `DATABASE_URL` and redeploys.
3. Seed once: `vercel env pull .env.local && DATABASE_URL=$(grep DATABASE_URL .env.local | cut -d= -f2-) npm run seed`
