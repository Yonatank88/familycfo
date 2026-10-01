---
name: category-deep-dive
description: Analyze one spending category over time — monthly trend, leaf categories, top merchants, unusual months. Use for "כמה אני מוציא על X", "למה X עלה", "ניתוח קטגוריה".
---

# Category deep-dive

1. Find the category in `/categories` (match the Hebrew name loosely; a parent includes its leaves). If it's ambiguous, pick the closest and say which.
2. Monthly trend: `/cashflow?cycles=12` → sum `byCategory` rows of that category (for a parent: rows whose `parentId` is it, plus the parent itself).
   Ignore months with almost no data. The current month is partial — show it separately.
3. Where it goes: `/transactions?category=ID&from=…&to=…&limit=1000` for the period → group by merchant (description); top 5 by total, with count.
4. For a parent, also the split between its leaf categories.

Answer (Hebrew):
- Monthly average (full months) and the last full month vs. that average.
- The trend in one sentence (rising / stable / falling), with the high and low months.
- Top merchants (table: merchant, ₪, number of purchases).
- What explains an unusual month — the specific purchases.
- The app's "מגמות הוצאות" page shows this as a chart, if they want to see it.
