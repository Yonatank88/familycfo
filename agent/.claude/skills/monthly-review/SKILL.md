---
name: monthly-review
description: Summary of a month — income, spend, what stood out, budgets, and how it compares to usual. Use for "סיכום חודש", "איך היה ספטמבר", "מה קרה החודש".
---

# Monthly review

1. Pick the month: the one asked about; "this month" = the current cycle (so far); "last month" = the previous cycle.
2. Get the numbers:
   - `/cashflow?cycles=7` — the month's income, spend, fixed / variable, `byCategory`, and the previous 6 months for comparison.
   - `/income?cycle=YYYY-MM` — income (arrived + still expected for the current month).
   - `/budgets?cycle=YYYY-MM` — budgets that are over or close.
   - `/transactions?cycle=YYYY-MM&kind=expense&limit=400` — to find the largest single purchases.
3. Compare to usual: average of the previous full months (skip months with almost no data). Flag categories more than 30% above their average.

Answer (Hebrew), in this order:
- One line: income, spend, net — and whether it's better or worse than usual.
- **What stood out**: 2–4 bullets — categories well above / below average, the biggest one-off purchases.
- **Budgets**: only the ones over or close to the limit.
- For the current month: say it's partial and what's still expected (income, card charges).
- One practical takeaway, if there is a clear one. No generic advice.
