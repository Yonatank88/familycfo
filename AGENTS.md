# AGENTS.md

Guidance for AI coding agents working in this repository (same content as CLAUDE.md).

## Commands

```bash
npm run scrape     # Scrape all banks and sync the investment sources once, then run the pipeline (SCRAPE_ONLY=oneZero,ibkr to limit; SCRAPE_FROM=2026-01-01 to backfill; SHOW_BROWSER=0 headless; SCHEDULE="0 7 * * *" to keep running on cron)
npm run dev        # API (127.0.0.1:4310) + dashboard (http://127.0.0.1:5180)
npm run pipeline   # Re-run classification / reconciliation without scraping (writes no snapshot)
npm run import -- <file>  # Import a report (pension, study fund, statement — PDF/CSV/XLSX/image): AI extraction → holdings, or review in the dashboard
npm run link -- onezero  # One-time One Zero SMS 2FA → saves the ~10-year credentials.idToken into accounts.json
npm run schedule:install # launchd: scrape daily at 07:00, log in data/logs/scrape.log (schedule:uninstall removes it)
npm test           # Vitest unit tests (in-memory SQLite)
npm run typecheck  # API typecheck; web: npm --prefix web run typecheck
```

## Architecture

A read-only money dashboard for one household: bank balances, investments by type, expenses, over time. Everything runs locally; the API binds to 127.0.0.1 only and has no login.

- `src/scraper.ts` — `israeli-bank-scrapers` (patched via `patches/` + patch-package: One Zero's mTLS client certificate, eshaham/israeli-bank-scrapers#1172 — drop the patch once a release includes it). Fetches 3 months back (or `SCRAPE_FROM`) + 2 future months, raw rows and scraper categories. Hapoalim OTP is prompted in the terminal (or the UI); One Zero logs in with `credentials.idToken` (`src/link.ts`; the patch also adds the idToken login, sergienko4/israeli-bank-scrapers#576). Every successful result is archived verbatim to `data/raw/<company>/<timestamp>.json` (`src/ingest/archive.ts`).
- `src/sync/` — investment sources (`investments[]` in accounts.json) → `holdings`: IBKR Flex Web Service, EVM wallets via Alchemy, exchanges via ccxt (optional dependency; read-only keys). Each adapter sets `asset_class` (`src/sync/assets.ts`: IBKR STK/ETF/FUND → `stock`, CRYPTO → `crypto`, `CASH.*` → `broker_cash`; coins: fiat → `broker_cash`, the shared `STABLECOINS` set (bridged tickers like USDC.e map to their base) → `stablecoin`, else `crypto`). `holdings.ts` upserts by `source` (`<source id>:<account>`) + symbol, archives what disappeared, and prices each position from its Yahoo symbol when the quote agrees with the source's price (±20%), else keeps the source's price as `manual_price`. Stablecoins are priced like any coin, never assumed to be $1.
- `src/db/` — `schema.ts` (one baseline, `schema_version` 100; a database with any other schema is refused — no upgrade from the old `bank.db`), `connection.ts` (`finance.db` unless `BANK_DB`), `ingestRepo.ts` (saves scraped accounts, `source_runs`, English source names).
- `src/ingest/` — `normalize.ts` (identity: bank reference + installment number, else md5 + occurrence suffix), `classify.ts` (category from the scraper's own category via `category_aliases`; `kind`), `transfers.ts` (card-bill reconciliation, immediate debit-card charges, own-account transfers).
- `src/analytics/` — `fx.ts` (Bank of Israel daily rates, backfilled per held currency; Yahoo only after BOI's last published day), `quotes.ts` (Yahoo quotes), `investments.ts` (holding valuation), `snapshots.ts` (`daily_snapshots` + bank history backfill), `summary.ts` (the dashboard's data).
- `src/reports/` — reports without an API (pension, study / provident funds, statements) → holdings. `extract.ts` runs the user's own `claude -p` (subscription: `ANTHROPIC_API_KEY` removed; Opus; `--json-schema`; only `Read`, confined to a temp dir holding just the file; prompts in `prompt.md` / `revise.md`; CSV/XLSX go in as text). `corroborate.ts` (deterministic): identity (provider + type + account number, else name similarity; ambiguous → question), edition (same issuer + as-of → replaces), checks that ask instead of applying (sum ≠ stated total ±1%, > 25% move from a report of the same type, a product of the previous report missing, confidence < 0.8, as-of missing / future). `index.ts`: files in `data/reports/<sha256>.<ext>` (same sha256 = already imported), `report_values` = every value point; a holding `report:<provider>:<account>` is priced at its latest point, with one snapshot per point date (step-held). Answers → one AI revision pass → corroborate again.
- `src/pipeline.ts` — after every scrape, in order: FX → quotes → categorize → kinds → card bills → immediate card debits → transfers → snapshots.
- `src/server/` — Fastify: `GET /api/summary?range=`, `/api/history?range=&group=type|source`, `/api/expenses?months=`, `/api/expenses/rows?month=&merchant=`; writes: `POST /api/scrape` and `/api/scrape/otp` (`scrapeJob.ts`, one scrape at a time, in memory); reports: `POST /api/reports` (multipart; extraction in the background), `GET /api/reports[/:id]`, `POST /api/reports/:id/answers`, `DELETE /api/reports/:id`.
- `web/` — Vite + React + Tailwind + Recharts, English LTR, light. One page: `web/src/Dashboard.tsx`.

**Key rules:**
- Transaction `kind` decides what counts: `transfer`, `card_payment` and `savings` are never spend. A bank row like `ויזה`/`כאל` is a `card_payment` only when a scraped card's charges explain it; otherwise it is a debit purchase (expense). Money sent to IBKR / Binance / Kraken / wallet on-ramps is `savings` (`INVESTMENT_PATTERN`).
- Expenses = `kind = 'expense'` minus refunds, in calendar months; installments count on their charge date (`processed_date`), other spend on the purchase date. Merchants are `merchantKey(description)`.
- Snapshots: written at the end of a run only for sources that succeeded in it (a failed source keeps its last snapshot); `as_of` = the source's own data time. Bank bucket = latest `balances` row of each bank account; card balances never count as Bank — unbilled card charges (future `processed_date`) are `cards_owed` (negative). Investment buckets = asset classes (report products: pension, study_fund, provident_fund, deposit, other; brokerage → stock).
- Bank history: from the movements' `runningBalance` + `valueDate` (exact; One Zero), else walked back from the latest balance over posted rows (fills only missing days).
- A missing exchange rate is flagged and the value left out — never 1:1.
- History by day carries each source's latest snapshot forward; a source counts only from its first snapshot. A range's change is "—" for a bucket whose sources weren't snapshotted by the range start.
- Hebrew regexes can't use `\b` (JS word boundaries are ASCII-only) — use explicit lookaheads. Hebrew matchers stay: they read Hebrew bank data.

**Configuration:**
- `accounts.json` (git-ignored; `ACCOUNTS_FILE` overrides): `accounts[]` with `companyId` and `credentials`; `investments[]` (`type`: `ibkr` / `wallets` / `exchange`). All secrets live in this one file.
- Ports: `PORT` (API, 4310) and `WEB_PORT` (web, 5180).
