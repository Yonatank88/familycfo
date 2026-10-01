---
name: insurance-review
description: Review all the household's insurance — what they have, what it costs, overlaps, gaps and upcoming renewals. Use for "סקירת ביטוחים", "כמה אני משלם על ביטוחים", "יש לי כפל ביטוח?", "מה חסר לי".
---

# Insurance review

1. `/insurance` — policies (type, insurer, who's insured, premium, end date, documents, actual payments) and `unlinked` charges.
2. For overlap questions, read the coverage summaries / tables in the documents (not the whole policies).

Answer (Hebrew):
- **What you have**: a table — policy, type, who's insured, ₪ per month (actual from payments when available), renews on.
- **Total**: per month and per year (actual charges in the last 12 months vs. the entered premiums).
- **Overlaps** (כפל ביטוח): same risk insured twice — typical: private health policy + the HMO's supplementary (שב"ן) for the same
  services, several life policies, critical illness in two places. Say what overlaps and what it costs; the user decides.
- **Gaps**, only when clear from the data (e.g. a mortgage without life insurance, a car with no comprehensive) — as questions, not advice.
- **Coming up**: renewals in the next 60 days — a good time to compare prices.
- **Charges with no policy**: insurance charges in `unlinked` — suggest adding them as policies (in the "ביטוחים" page) so they're tracked.
- No product recommendations; you're not a licensed insurance agent.
