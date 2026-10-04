# Reports import (AI)

Drop a report (PDF, CSV, XLSX, image) → AI extracts the accounts/products and their values → corroborated against
earlier reports → becomes portfolio data. Dropping the same report again, or a newer edition, updates instead of
duplicating. When the AI isn't sure, it asks.

## Scope
Anything that states balances on a date and has no API: pension (קרן פנסיה, ביטוח מנהלים), study fund (קרן השתלמות),
provident fund (קופת גמל, גמל להשקעה), brokerage/bank statements from institutions we don't scrape, deposits. Typical
sources: המסלקה הפנסיונית consolidated report, הר הכסף export, agent reports, fund statements.

Kept per product: provider, product type, account/policy number, name, balance (+ currency), as-of date, owner name
as printed, liquidity date when stated (hishtalmut: join date + 6 years). Nothing else (no fees, tracks, deposits).

## Flow
1. **Drop** — a drop zone on the dashboard (header "Add report" + drag anywhere) and `npm run import -- <file>`. The
   file is copied to `data/reports/<sha256>.<ext>` (git-ignored). Same sha256 as an existing report → "already
   imported", nothing else happens.
2. **Extract** — the user's own `claude -p` (subscription, `ANTHROPIC_API_KEY` removed, as the old data chat did),
   model Opus 5.5 (`claude-opus-5-5`), tools limited to `Read` on that one file, `--json-schema` structured output:
   ```
   { issuer, reportType, asOf, owner?, statedTotal?, currency,
     products: [{ provider, productType, accountNumber?, name, balance, currency, liquidityDate?, confidence, evidence }],
     questions: [{ id, text, options?: string[] }] }
   ```
   `productType` ∈ pension | study_fund | provident_fund | mutual_fund | brokerage | deposit | other (mutual_fund = קרן
   נאמנות, also inside a bank / brokerage statement; its accountNumber is the fund number when printed). `evidence` = the page/line text the
   number came from. CSV/XLSX are converted to text first; PDFs and images are read directly.
3. **Corroborate** (code, deterministic) against what's already stored:
   - Identity: provider + productType + normalised account number. No account number → match by provider + type + name
     similarity; ambiguous → question ("Is 'מגדל השתלמות' the same as 'Migdal Study Fund ••4821'?").
   - Same issuer + same `asOf` as an existing report → it's an edition of that report → replace its products.
   - Newer `asOf` for a known product → new value point; older → history point only (current value unchanged).
   - Checks that raise a question instead of applying: products don't sum to `statedTotal` (±1%); a value moved > 25%
     since the last point with no new report type to explain it; a product in the previous report from the same issuer
     is missing; any product with `confidence` < 0.8; `asOf` missing or in the future.
4. **Review** — when there are questions, the report is `needs_review`: a panel lists the extracted products (editable
   balance/date only) and the questions (option buttons or free text). Answers are sent back to the AI with the
   extraction for one revision pass; then corroboration runs again. No questions → applied automatically.
5. **Apply** — each product becomes a holding: `source = report:<provider-slug>:<account>`, quantity 1, ILS (or its
   currency) `manual_price` = balance, `manual_price_date` = asOf. Value stays until a newer report. History: a
   `daily_snapshots` row on each report's asOf for that source, step-held between reports (chart and range change use
   them like any other source).

## Data
Schema step 102:
- `reports(id, sha256 UNIQUE, file, original_name, issuer, report_type, as_of, status CHECK in
  (extracting, needs_review, applied, superseded, failed), extraction JSON, questions JSON, answers JSON, error,
  created_at, applied_at)`
- `report_values(report_id, holding_source, product_type, name, balance, currency, as_of, liquidity_date)` — every
  value point ever applied; current holdings are derived from the latest point per `holding_source`.
- `holdings.asset_class` CHECK widened (table rebuild) with pension | study_fund | provident_fund | deposit | other;
  brokerage report products map to stock unless stated otherwise.
- Dashboard types gain Pension, Study funds (with "liquid from" date in the holdings list), Provident funds.

Schema step 103: `holdings.asset_class` CHECK widened (table rebuild) with mutual_fund — dashboard type "Funds".

## API
- `POST /api/reports` (multipart) → report id, status
- `GET /api/reports` — list with status
- `GET /api/reports/:id` — extraction, corroboration result, questions
- `POST /api/reports/:id/answers` — answers + optional balance/date edits → revise + corroborate
- `DELETE /api/reports/:id` — removes its value points (holdings recomputed)

## UI
- "Add report" in the header + full-page drop overlay while dragging.
- Reports list (compact, below Accounts): file, issuer, as-of, status chip, open.
- Review panel for `needs_review` (questions first, then the extracted table with evidence on hover).
- Extraction runs in the background; the list shows progress.

## Privacy
The report's content goes to Anthropic through the user's Claude login — say so once in the drop dialog footer.

## Tests
Identity matching (account number, name similarity, ambiguity → question); edition replace vs newer vs older point;
duplicate sha256; sum check; > 25% jump; missing product; low confidence; answers → revision; delete recomputes; the AI
call mocked.
