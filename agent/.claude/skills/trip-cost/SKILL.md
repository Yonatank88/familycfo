---
name: trip-cost
description: What a trip, holiday or event cost — by tag (event) or by dates and destination. Use for "כמה עלה הטיול", "עלות החופשה", "כמה הוצאנו על החתונה / יום ההולדת".
---

# Trip / event cost

1. `/events` — events are tags with totals and date ranges. Match by name (Hebrew or English, loosely).
2. Found: `/events/ID` — total, breakdown by category and member, foreign-currency spend, its transactions.
3. Not tagged: find it by dates with `sql` — foreign-currency rows (`original_currency <> 'ILS'`), flights, hotels, car rental around the dates mentioned.
   Say it isn't tagged and suggest tagging it in "אירועים ותגיות", so it's tracked from now on.

Answer (Hebrew):
- Total cost, dates, and per day / per person if obvious.
- Breakdown: flights, lodging, food, activities, shopping (table).
- Foreign-currency spend in the original currency too.
- Installments still to be charged, if any (they're part of the cost).
