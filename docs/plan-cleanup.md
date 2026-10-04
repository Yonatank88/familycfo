# FamilyCFO cleanup plan (v2 — after GPT-5.6 Sol, Grok 4.7 and Fable reviews + UX research)

## Goal
A read-only money dashboard for one household: money in the bank, money in investments by type, expenses when bank
data allows it, all over time. No input, no members / partner split. English, LTR, light.

## One page

Header row
- **Net worth** (₪) + change for the selected range, as ₪ and %. Below it: **Bank** · **Investments** · **Cards owed**
  (the last only when a card account is scraped).
- **One range selector** for the whole page: 1M · 3M · YTD · 1Y · All.
- Change shows "—" for a bucket that has no snapshot at the start of the range (investment history starts at the first
  sync, so early ranges must not report the whole portfolio as gain).

Over time
- Stacked area, daily, toggle **Type / Source**. Types: Bank, Stocks & ETFs, Crypto, Stablecoins, Broker cash.
  Sources: One Zero, Hapoalim, IBKR, Binance, Kraken, Wallets.
- Hover: date + full breakdown. The chart starts where data starts; no painting today's quantities backward.

Allocation
- Donut + ranked list beside it (same Type/Source toggle). Max 5 slices.

Accounts
- Compact list: source, value ₪, native currency in small type when not ILS, **as of** time, stale dot when the last
  successful sync is older than 36 h.

Holdings
- Top 10 by value: symbol, value ₪, % of investments, change for the range. "Show all" expands in place.

Expenses (hidden when there are no expense rows)
- Monthly bars, last 12 months with data, current month highlighted.
- Top 8 **merchants** for the selected month (categories only where the source supplies one — One Zero supplies none).

Avoid: per-widget ranges, tabs, pies over 5 slices, performance metrics (TWR/IRR/benchmarks), explainer copy.

## Data

### Fresh database, new file
New file `finance.db` (`BANK_DB` default changes) with one baseline migration; the code refuses to open a DB whose
`schema_version` doesn't match the baseline (old `bank.db` is v16 from an unmerged migration — keep it as a backup
until verification, then delete).

Baseline tables:
- `accounts`, `balances` (one row per account per scrape), `transactions` (keeps `kind`, `is_debit`,
  `matched_txn_id`, `processed_date`, `raw_json`), `categories`, `category_aliases`
- `holdings` (+ `asset_class`, `source`, `synced_at`, `manual_price`; no buy/baseline/yield fields), `quotes`, `fx_rates`
- `source_runs(source, started_at, ok, error, as_of)` — replaces `scrape_runs`
- `daily_snapshots(date, source, bucket, value_ils, as_of, PRIMARY KEY(date, source, bucket))`
No member, tag, rule, budget, link, insurance, pension, asset or liability tables; no member foreign keys or columns.

### Asset class (stored, set by each sync adapter)
- IBKR: instrument type → `stock` (STK/ETF/FUND), `crypto` (CRYPTO), `broker_cash` (`CASH.*`).
- Exchanges / wallets: fiat (USD/EUR/ILS) → `broker_cash`; one shared stablecoin set (USDT, USDC, DAI, FDUSD, PYUSD, …,
  exported from one module and used for both pricing and bucketing; stablecoins priced from the source/Yahoo, not
  hard-coded to $1) → `stablecoin`; everything else → `crypto`. Wrapped/bridged stables (USDC.e) map to their base.

### Snapshots
Written at the end of each run, **only for sources whose sync succeeded in that run**; a failed source keeps its last
snapshot (no carry-forward stamped as today). `as_of` = the source's own data time.
- Bank bucket: latest `balances` row per `kind = 'bank'` account, converted with that day's rate. Card balances never
  go into Bank; unbilled card charges (future `processed_date`) form "Cards owed".
- Investment buckets: `valueHolding` per holding after the quote refresh; a row with no FX rate is skipped and the
  source flagged, never valued 1:1.

### Bank history backfill
From the raw movements' `runningBalance` + `valueDate` (One Zero provides them; exact, no reconstruction). Fallback for a
source without running balances: walk back from each `balances` anchor using only posted transactions dated on/before
the anchor, in account currency. One Zero history is capped at one year by the scraper.

### FX
Bank of Israel daily rates backfilled for every currency present (bank accounts + holdings) over the snapshot range;
Yahoo fills gaps, never overrides BOI. Missing rate → flagged, not 1.

### Pipeline (kept, in this order)
FX → quotes → categorize (scraper category → aliases; no rules) → `deriveKinds` → `reconcileCardBills` →
`matchImmediateCardDebits` → `matchInternalTransfers` → snapshots.
- Extend the savings/investment pattern so transfers to IBKR / Binance / Kraken (and wallet funding) are `savings`,
  not expenses — in code, with tests.
- Expenses = `kind = 'expense'` minus refunds, installments on `processed_date`, calendar months. Bit/PayBox paybacks are
  not netted (accepted: slightly higher spend).

## Keep
`src/scraper.ts`, `src/sync/*` (minus `ownerMemberId`), `src/link.ts`, raw archive, mTLS patch, `ingest/normalize.ts`,
`ingest/classify.ts` (minus member/tag writes and rules), `ingest/transfers.ts`, `analytics/fx.ts`,
`analytics/quotes.ts` (minus `refreshHistory`/`quote_history`), the valuation part of `analytics/investments.ts`,
`SCHEDULE` cron mode. Hebrew description matchers stay (they read Hebrew bank data).

## Delete
- All 14 pages except a new `Dashboard`; components AgentChat, ManualEntry, ScheduledManager, StartOfMonth, DayDetails,
  CategoryReport, ScrapeButton; members/business/tag filters (`state.tsx`).
- Backend: AI chat (`server/agent.ts`, `src/agent/`, `agent/`), `server/crud.ts`, `server/scrapeJob.ts`, routes
  categories/events/insurance/pension/transactions, imports, `categorizer.ts` + `categoryApiUrl`.
- Analytics: alerts, budgets, cards, cashflow, commitments, common (`loadTransactions`), forecast (move
  `bankBalances` into the summary module), networth (replaced), paybacks, planned, planning, recommendations,
  recurring, scheduled; `quote_history`/`refreshHistory`; quote-search, yield and baseline routes.
- Existing tests (all touch deleted modules) — replaced, not extended.
- Branch `wip-english-partial`; Hebrew display names in the backend (`COMPANY_NAMES`, "מזומן", "ארנק קריפטו") →
  English; `web/index.html` → `lang="en"`, no `dir="rtl"`.

## API (GET only)
- `/api/summary` — net worth, buckets, accounts with `as_of`/stale, holdings
- `/api/history?range=&group=type|source` — `daily_snapshots`
- `/api/expenses?months=12` — monthly totals + top merchants per month

## Steps
1. Branch `cleanup`. Delete UI + backend features; app builds.
2. Baseline schema in a new DB file; `asset_class` in sync adapters; `source_runs`; snapshot step; FX backfill.
3. Pipeline order + investment-transfer pattern.
4. Three GET endpoints; summary module.
5. Dashboard page (English, LTR, light).
6. Tests: kinds + card reconciliation + immediate debits + transfers + investment-funding exclusion; refunds and
   installments in expenses; asset-class mapping incl. IBKR crypto and stablecoins; snapshot only-on-success; missing FX
   flagged; `runningBalance` backfill. Typecheck + build.
7. Scrape everything into `finance.db`. Verify: per-account bank balances and per-holding values equal the old app's
   (bank balances + holdings totals only — the old net worth also subtracts cards and adds pension, so it isn't
   comparable). Then delete `bank.db`.
8. README / CLAUDE.md; merge to `main`, push.

## Owner decisions
- **Refresh:** a Refresh button in the header (runs the scrape; shows the OTP prompt only when a bank asks) + a daily
  automatic run (launchd, 07:00). Keep `server/scrapeJob.ts` and `POST /api/scrape` (+ `/otp`); those are the only
  write endpoints.
- **Currency:** ₪ / $ toggle for the whole page. Snapshots stay in ILS; USD view converts with that day's USD rate.
- **Expenses:** click a month bar or a merchant → the matching rows (date, description, account, amount) in a panel.
  `GET /api/expenses/rows?month=&merchant=`. Read-only.
