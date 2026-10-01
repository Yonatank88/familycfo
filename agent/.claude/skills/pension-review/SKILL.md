---
name: pension-review
description: Review pension and long-term savings — pension funds, managers' insurance, study funds, provident funds: how much, where, fees, returns, deposits, expected pension, what's liquid. Use for "פנסיה", "קרן השתלמות", "קופות גמל", "כמה חסכתי", "דמי ניהול", "מתי נזיל", "כמה פנסיה אקבל".
---

# Pension & long-term savings review

1. `/pension` — products and the latest report summary. For a detail that isn't in the data, open the report (`report.documentPath`).
2. Answer what was asked; for a general review cover:
   - **Total** and the split by type / provider (as of the report date).
   - **Active vs. inactive**: which products still get deposits (employer, monthly amount), how many sit inactive and how much is in them.
   - **Fees**: from deposits and from balance per product; products with the same type but different fees.
   - **Returns**: per track — YTD and 12 months; 3 / 5 years when available. Same track in several products = same returns.
   - **Liquid now**: study funds past their `liquidityDate` (tax-free to withdraw), and when the rest become liquid.
   - **Expected pension**: monthly, without and with continued deposits (from the report).
   - **Insurance inside the pension fund**: disability / survivors coverage and what it costs per month.
3. Deposits: check the latest months are there for active products (a missing month = worth asking the employer).

Rules: facts and numbers only — no recommendations to move money, consolidate, or change tracks. When something looks worth checking
(many inactive accounts, a higher fee, a missing deposit), say so as a question to raise with the agent (name / phone in `report.summary.agent`).
