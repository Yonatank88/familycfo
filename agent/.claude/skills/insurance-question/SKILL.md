---
name: insurance-question
description: Answer a question about what an insurance policy covers — from the uploaded policy documents. Use for "האם הביטוח מכסה…", "מה ההשתתפות העצמית", "מה הכיסוי ל…", "מתי הפוליסה מתחדשת", "איך מגישים תביעה".
---

# Insurance coverage question

1. `/insurance` — find the relevant policy (by type, insurer, who's insured). If several could apply (e.g. two health policies), check each.
2. Read its documents (`documents[].path`, `kind = policy` first, then appendices / renewals — the newest renewal wins for premiums and dates).
   For a long PDF: find the coverage table / table of contents first, then read only the relevant pages.
   The policy's `notes` and the "תיעוד מהאזור האישי" document say what's known and what's still missing; for an overview of every policy
   (premiums, dates, coverage flags) read the Har HaBituach summary in `./docs/reports/`, if one was imported.
3. Find the exact clause: coverage, limit / sum insured, deductible (השתתפות עצמית), waiting period (תקופת אכשרה), exclusions (חריגים), conditions.

Answer (Hebrew):
- The direct answer first: covered / not covered / partly / not stated in the documents.
- The details that matter: limit, deductible, waiting period, exclusions, what's needed to claim.
- The source: document name + section / page, with a short quote of the key wording.
- If another policy they have might cover it better (or duplicates it), mention it.
- If it isn't in the documents or is ambiguous: say so and suggest asking the agent / insurer (name and phone from the policy, if entered).
