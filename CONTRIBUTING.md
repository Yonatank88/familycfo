# Contributing

Thanks for helping! Bug reports, bank-specific fixes, new analytics and UI improvements are all welcome.

## Before you start

- **Never include real financial data** in an issue, a PR, a test or a screenshot — no account numbers, names,
  balances, transaction descriptions or documents. Reproduce bugs with made-up rows in a test.
- For a larger change, open an issue first to agree on the approach.

## Setup

```bash
npm install
BANK_DB=test.db npm run dev   # work against a scratch database
```

Experiment on a copy of a real database, never on the original: `BANK_DB=copy.db npm run dev`.

## Checks

```bash
npm test
npm run typecheck
npm --prefix web run typecheck
```

Add or update tests in `tests/` for logic changes (they use an in-memory SQLite, see `tests/helpers.ts`).

## Conventions

- Read [CLAUDE.md](CLAUDE.md) — the architecture and the accounting rules (what counts as spend, card bills,
  transfers, installments, snapshots) that every change must keep.
- Schema changes: a numbered step after the baseline in `src/db/schema.ts`. Never edit the released baseline.
- Analytics are pure functions in `src/analytics/`; the API in `src/server/` stays thin.
- The UI is one English, LTR, light page (`web/src/Dashboard.tsx`).
- Keep the app local-only: the API binds to 127.0.0.1, and nothing personal may be sent anywhere new without it
  being opt-in and documented in the README's privacy section.
