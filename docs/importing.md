# Importing pension and insurance reports

Pension, study-fund and insurance data doesn't come from the bank scrape — it comes from reports: the periodic report
of your insurance / pension agent, the pension clearing house (המסלקה הפנסיונית), הר הביטוח, or the insurers' personal
areas. Those are PDFs, so the flow is:

1. Put the PDF in `data/reports/` (git-ignored — it's personal).
2. Extract what's in it to a JSON file next to it, in the format below. Doing it by hand works; so does giving the PDF
   and this page to an AI assistant and asking for the JSON. **Check the numbers** — the pension importer refuses a
   report whose products don't add up to its stated total.
3. Import it. Both importers are idempotent: running them again updates what changed and never duplicates.

Complete, importable examples: [`examples/pension-report.example.json`](examples/pension-report.example.json) and
[`examples/insurance.example.json`](examples/insurance.example.json).

Member names in these files (`member`, `insured`) must match a household member's name in Settings → בני הבית.

---

## Pension / long-term savings report

```bash
npm run import:pension -- data/reports/2026-06-pension-report.json
```

Each product becomes an asset on the **פנסיה וגמל** page (and in net worth): a value snapshot on the report date, fees,
tracks with returns, deposits per salary month. Insurance policies listed in the report are added to **ביטוחים**.
The report's own totals (exposures, expected pension, the agent's details) are kept and shown as they are.

| Field | Type | |
|---|---|---|
| `asOf` | `YYYY-MM-DD` | The date the values are correct for. |
| `member` | string | Whose report it is (a member name). |
| `source` | string | Who produced it — with `asOf` and `member`, identifies the report on re-import. |
| `file` | string? | The PDF's file name in `data/reports/` (the data chat can open it). |
| `issuedAt` | `YYYY-MM-DD`? | |
| `agent` | `{ name, agency?, phone?, email? }`? | Shown on the page; questions are referred to them. |
| `summary` | object | The report's own totals — see below. `totalSavings` is required. |
| `products` | array | One entry per pension fund / managers' insurance / study fund / provident fund. |
| `insurance` | array? | Policies listed in the report (risk life, disability, health …). |

`summary` (shown as-is on the pension page; omit what the report doesn't state):
`totalSavings`, `ytdReturnPct`, `lifeHealthMonthlyPremium`, `byProductType` / `byProvider` (`[{ name, amount, pct }]`),
`tradedPct` (`{ traded, nonTraded }`), `exposurePct` (`{ stocks, abroad, foreignCurrency }`), `assetMixPct`
(`[{ name, pct }]`), `monthlyDeposits` (`{ <type>: amount, total }`), `expectedAnnuity`
(`{ pensionWithoutDeposits, pensionWithDeposits, managers, totalWithoutDeposits }`), `coverage`
(`{ disability, death, noInfo: [] }`).

A product:

| Field | Type | |
|---|---|---|
| `type` | `pension` \| `keren_hishtalmut` \| `kupat_gemel` | Managers' insurance (ביטוח מנהלים) is `pension`. |
| `name`, `provider`, `policyNumber` | string | Provider + policy number + type + name identify the product on re-import. |
| `balance` | number | Value on `asOf`. |
| `status` | `active` \| `inactive` | Whether deposits still come in. |
| `employer` | string? | The depositing employer. |
| `joinDate` | `YYYY-MM-DD`? | For a study fund, it becomes liquid 6 years after joining. |
| `feeDeposit`, `feeBalance` | number? | Management fees: % of each deposit, % of the balance a year. |
| `regularDeposit` | number? | Monthly deposit (active products). |
| `insuredSalary`, `lastDeposit` | number?, date? | |
| `expectedAnnuity`, `expectedAnnuityWithDeposits` | number? | Expected monthly pension, without / with further deposits. |
| `tracks` | `[{ name, share, balance, returns }]`? | `returns` = 7 numbers (or `null`), in %: last month, YTD, 12 months, 3 years, 5 years, 3-year average, 5-year average. |
| `components` | `{ pitzuyim, tagmulim, capital }`? | |
| `coverages` | `[{ name, pct, monthly }]`? | Insurance inside a pension fund (disability, survivors). |
| `coverageCost` | `{ disability, survivors }`? | Its monthly cost. |
| `deposits` | array? | Rows of `[valueDate, salaryMonth "YYYY-MM", salary, employee, employer, severance, total]`. |

An `insurance` entry: `name`, `type` (see the types below), `insurer`, `policyNumber`, `premium`, `premiumFrequency`
(`monthly` \| `yearly` \| `one_time`), and optionally `startDate`, `matchPattern`, `coverage`, `notes`.

---

## Insurance policies and documents

```bash
npm run import:insurance -- data/reports/insurance.json
```

For adding or updating many policies at once, with their documents (policy terms, appendices, renewals). Single
policies are easier to add on the **ביטוחים** page, where you can also drag documents onto a policy.

```json
{
  "documentsRoot": "documents",
  "policies": [
    {
      "insured": "בן/בת זוג 1",
      "set": { "name": "ביטוח בריאות פרטי", "type": "health", "insurer": "כלל", "policyNumber": "000777888",
               "premium": 142.5, "premiumFrequency": "monthly", "matchPattern": "כלל ביטוח" },
      "documents": [{ "file": "health-policy.pdf", "name": "פוליסת בריאות — תנאים כלליים", "kind": "policy" }]
    },
    { "match": { "insurer": "הראל", "policyNumber": "000555666" }, "set": { "endDate": "2045-02-01" } }
  ],
  "assetSnapshots": [{ "provider": "מגדל", "policyNumber": "000111222", "date": "2026-09-30", "value": 318500 }]
}
```

- **`documentsRoot`** — the folder the document paths are relative to (itself relative to the JSON file).
- **A policy entry** — found by `match` (insurer + policy number, plus `name` when one number covers several policies),
  or by the `insurer` + `policyNumber` in `set`. Found → the fields in `set` are updated; not found → it's created
  (`name` required).
- **`set`** — any policy field, as in the API: `name`, `type`, `insurer`, `policyNumber`, `insuredDetails`, `premium`,
  `premiumFrequency`, `paymentAccountId`, `matchPattern`, `startDate`, `endDate`, `coverage`, `deductible`, `agentName`,
  `agentPhone`, `agentEmail`, `notes`, `archived`.
- **`insured`** — a member name (or `null` for the whole household).
- **`type`** — `health`, `life`, `nursing`, `critical_illness`, `disability`, `car`, `home`, `mortgage`, `travel`, `pet`, `other`.
- **`documents`** — PDF, PNG, JPG, WebP, Markdown or text; `kind` is `policy`, `appendix`, `renewal`, `claim` or `other`.
  Each file is copied to `data/policies/<policy id>/` once (by its name).
- **`assetSnapshots`** — a value for an existing asset (by provider + policy number), e.g. a balance you saw on a portal.

### Matching what a policy actually costs

`matchPattern` is text that appears in the policy's card / bank charges (e.g. `"הראל"`). The insurance page sums the
matching charges of the last 12 months next to the premium you entered, and lists insurance charges that no policy
explains yet. When the same insurer charges two different policies, set `paymentAccountId` (the account id from
Settings) so each policy only counts the charges of its own card.

---

## Stock-market holdings

These aren't imported from a file — add them on the **השקעות** page: the symbol (search by name, or e.g. `AAPL`,
`VOO`, `LUMI.TA` for Tel Aviv), the quantity and, optionally, the average buy price and date. Prices are fetched live
from Yahoo Finance. Something with no quote (an Israeli mutual fund, cash in the brokerage account) gets a manual price.
