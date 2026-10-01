---
name: subscriptions-audit
description: Find subscriptions, standing orders and recurring charges, what they cost per month and year, and which may be worth cancelling. Use for "מנויים", "הוראות קבע", "על מה אני משלם כל חודש", "מה אפשר לבטל".
---

# Subscriptions audit

1. `/recurring` — the recurring series the app detected (merchant, typical amount, cadence, last seen).
2. `/recommendations` — the app's own savings suggestions (duplicate services, price increases).
3. Fill gaps with `sql`: merchants charged in at least 3 of the last 4 months with a similar amount, e.g.

   ```sql
   SELECT description, COUNT(DISTINCT substr(date, 1, 7)) AS months, ROUND(AVG(-charged_amount)) AS avg_amount, MAX(date) AS last
   FROM transactions
   WHERE kind = 'expense' AND excluded = 0 AND date >= date('now', '-4 months') AND txn_type IS NOT 'installments'
   GROUP BY description HAVING months >= 3 ORDER BY avg_amount DESC;
   ```
4. Leave out what isn't a "subscription": loans, mortgage, rent, insurance and taxes — list them separately only if asked.

Answer (Hebrew):
- Total per month and per year for subscriptions / digital services.
- A table: service, ₪ per month, since when / last charge, whose card.
- **Worth a look**: duplicates (two streaming / cloud services), price increases, something not charged recently (maybe cancelled), small forgotten ones.
