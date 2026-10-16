# Lead Dedupe

Upload a CSV → see which emails are already in the database → download only the new leads.

## How it works

1. Drop a CSV. The email column is **detected by content** (whichever column holds the most valid `name@domain.tld` values wins — `Email`, `business_email`, anything).
2. Each email is trimmed + lowercased and checked against the store.
3. Left panel = already in DB (with source campaign). Right panel = new leads.
4. **New leads are saved to the database immediately on upload** — you do not need to download them.
5. Two export buttons: `-new.csv` (leads not in the DB) and `-existing.csv` (leads already in the DB). Duplicates are removed and rows closed up, all original columns kept.

## Storage

Vercel Blob (`BLOB_READ_WRITE_TOKEN`), private, one JSON blob per key:

- `lead-dedupe/emails.json` — `{ [email]: campaign }`
- `lead-dedupe/campaigns.json` — upload history

Without `BLOB_READ_WRITE_TOKEN`, it falls back to `data/db.json` for local dev.

> **Note:** `emails.json` is written with a read-modify-write. `readBlob` therefore
> **throws** on failure instead of returning an empty object — otherwise a transient
> read error would look like "empty database" and overwrite every stored email.

## Run locally

```bash
npm install
npm run dev        # uses data/db.json when BLOB_READ_WRITE_TOKEN is missing
```

## Seed

```bash
npm run seed   # loads data/seed-emails.json (13,152 emails)
```

## Deploy (Vercel)

Push to GitHub — Vercel auto-deploys.
