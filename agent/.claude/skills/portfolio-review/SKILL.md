---
name: portfolio-review
description: Review the stock-market portfolio — holdings, live value, gain / loss vs. the buy price, today's change, allocation by security / currency / broker. Use for "תיק ההשקעות", "מניות", "כמה הרווחתי", "כמה שווה התיק", "מה קרה היום בתיק", "פיזור".
---

# Stock-market portfolio review

1. `/investments` — every holding at its live price (Yahoo Finance; TASE prices can lag ~15 minutes) and the totals.
2. Answer what was asked; for a general review cover:
   - **Value** now in ₪ and how many holdings; the split by holding (`valueIls` / total), by currency (`byCurrency`) and broker.
   - **Gain / loss**: total and per holding, in ₪ (`gainIls`, `gainIlsPct` — includes the exchange-rate effect) and, for foreign
     securities, in their own currency (`gainPct`). Say what it's measured from: `basis = buy` (the buy price) or `baseline`
     (the price on `baselineDate`, when no buy price was entered).
   - **Today**: `totals.dayChangeIls` / `dayChangePct`; a holding with `dayChangePct = null` hasn't traded yet today.
   - **Concentration**: the biggest holdings' share of the portfolio, the share in foreign currency.
   - `history` is the value over time — from the buy dates where known (quantities are assumed unchanged since).
3. Mention stale data: `quoteError` on a holding, `priceSource = manual` (price entered by hand — say its `manualPriceDate`).

Rules: facts and numbers only — never recommend buying, selling or rebalancing. Point out what stands out (a large share in one
security, a loss, a stale manual price) as an observation.
