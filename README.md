# FamilyCFO

A local, read-only money dashboard for one household. It scrapes your Israeli bank accounts and credit cards
(via [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers)), syncs your broker, crypto wallets and
exchanges, keeps everything in a SQLite file on your own computer, and shows one page: money in the bank, investments by
type, expenses, all over time.

## Privacy and security

- **Everything stays on your machine.** The API binds to `127.0.0.1` only and has **no login** — never expose it to a
  network.
- Logins and API keys live in `accounts.json` (git-ignored). The database `finance.db` and the raw scrape archive
  (`data/`) are git-ignored too. **Never commit them.**
- Outgoing network calls, and what they send:
  - your banks / card companies (the scraper logs in as you, in a local Chrome);
  - the investment sources you configure: Interactive Brokers (your Flex token), Alchemy (your wallet **addresses** only)
    and your exchanges (read-only API keys);
  - Bank of Israel exchange rates (nothing personal);
  - Yahoo Finance quotes and FX rates — **only symbols**, never quantities or values.

## Setup

Requirements: **Node.js 20+** and npm, macOS or Linux.

1. **Install:** `git clone https://github.com/Yonatank88/familycfo.git && cd familycfo && npm install`.

2. **Add your logins:** `cp accounts.example.json accounts.json`, then one entry per bank or card company —
   `companyId` (an `israeli-bank-scrapers` company id) and the `credentials` its login needs:

   | Company | `companyId` | `credentials` |
   |---|---|---|
   | Bank Hapoalim | `hapoalim` | `userCode`, `password` |
   | Bank Leumi | `leumi` | `username`, `password` |
   | Discount / Mercantile | `discount` / `mercantile` | `id`, `password`, `num` |
   | Mizrahi Tefahot | `mizrahi` | `username`, `password` |
   | Beinleumi / Massad / Otsar Hahayal / Union | `beinleumi` / `massad` / `otsarHahayal` / `union` | `username`, `password` |
   | Yahav | `yahav` | `username`, `nationalID`, `password` |
   | One Zero | `oneZero` | `email`, `password`, `phoneNumber` (`+972…`) — then `npm run link -- onezero`, see below |
   | Isracard / American Express | `isracard` / `amex` | `id`, `card6Digits`, `password` |
   | Max | `max` | `username`, `password` |
   | Cal | `visaCal` | `username`, `password` |

   The full list is in the
   [israeli-bank-scrapers docs](https://github.com/eshaham/israeli-bank-scrapers#specific-definitions-per-scraper).

   **One Zero** texts a code on every login. Link it once: `npm run link -- onezero` saves a ~10-year token into
   `accounts.json` (never printed). Run it again when the token expires.

3. **Brokers, wallets and exchanges** go in `investments` in `accounts.json`:

   | `type` | Source | Settings |
   |---|---|---|
   | `ibkr` | Interactive Brokers — positions and cash via a Flex Query (*Open Positions* summary + *Cash Report*) | `token`, `queryId` |
   | `wallets` | EVM wallets via [Alchemy](https://www.alchemy.com/) | `apiKey`, `wallets: [{ address, label? }]`, `networks?`, `minUsd?` |
   | `exchange` | Binance, Kraken, or any [ccxt](https://github.com/ccxt/ccxt) exchange — a **read-only** key | `exchange`, `apiKey`, `secret`, `password?` |

   Each position is stored with an asset class: Stocks & ETFs, Crypto, Stablecoins or Broker cash.

4. **Scrape:** `SCRAPE_FROM=2025-10-01 npm run scrape` (without `SCRAPE_FROM`: the last 3 months). A Chrome window opens
   per company (`SHOW_BROWSER=0` for headless); a Hapoalim SMS code is asked in the terminal.

5. **Open the dashboard:** `npm run dev`, then <http://127.0.0.1:5180>.

## Everyday use

- **Refresh** in the dashboard header runs the same scrape and asks for an OTP code in the page when a bank wants one.
- **Daily at 07:00:** `npm run schedule:install` (launchd; log in `data/logs/scrape.log`), `npm run schedule:uninstall`
  to remove it. Alternatively `SCHEDULE="0 7 * * *" npm run scrape` keeps a process running on that cron schedule.
- History starts where data starts: bank balances are backfilled from the bank's running balances (One Zero gives one
  year), investments from their first sync. A source that fails keeps its last snapshot.
- Every scrape / sync result is kept untouched in `data/raw/<source>/<time>.json`.

## Configuration

| Setting | Where | Default | What |
|---|---|---|---|
| `accounts`, `investments` | `accounts.json` | — | Bank / card logins and investment sources. |
| `ACCOUNTS_FILE` | env | `accounts.json` | Path of the logins file. |
| `BANK_DB` | env | `finance.db` | Database file. |
| `PORT` / `WEB_PORT` | env | `4310` / `5180` | API and web ports (both bind to 127.0.0.1). |
| `SCRAPE_ONLY` | env | all | `SCRAPE_ONLY=oneZero,ibkr` scrapes / syncs only these. |
| `SCRAPE_FROM` | env | 3 months back | Start date of the scrape (`YYYY-MM-DD`). |
| `SHOW_BROWSER` | env | shown | `0` runs Chrome headless. |
| `SCHEDULE` | env | none | Cron expression; keeps `npm run scrape` running. |
| `RAW_DIR` | env | `data/raw` | Where raw payloads are archived. |

## Development

```bash
npm test                        # unit tests (in-memory SQLite, no network)
npm run typecheck               # API
npm --prefix web run typecheck
```

Architecture notes and the accounting rules are in [CLAUDE.md](CLAUDE.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting

- **A login fails / times out:** run with the browser shown to see where it stops; update `israeli-bank-scrapers`.
- **One Zero fails with an invalid token:** `npm run link -- onezero` again.
- **An investment source fails:** its holdings and last snapshot stay as they were; the account shows a stale dot.
  IBKR Flex tokens expire — renew under Flex Web Service.
- **A value is missing:** a currency with no Bank of Israel or Yahoo rate is left out (never valued 1:1).

## Disclaimer

This is a personal-finance tool, not financial, tax, insurance or investment advice. Numbers can be wrong: scrapers
miss rows, categories are guesses, prices can lag. Using scrapers with your own credentials may be subject to your
bank's terms of use — that's your call. No warranty; see the license.

## License

[MIT](LICENSE)
