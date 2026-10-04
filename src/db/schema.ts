import type Database from 'better-sqlite3';

/**
 * The whole schema, as one baseline. There is no upgrade path from the old household database (bank.db): a database
 * whose schema_version isn't exactly the baseline is refused. A later change adds a numbered step after the baseline.
 */
export const BASELINE_VERSION = 100;

/** Steps after the baseline, applied in order to a database that has the baseline and a prefix of these. */
const STEPS: { version: number; name: string; sql: string }[] = [
  { version: 101, name: 'holdings.cost_basis', sql: `ALTER TABLE holdings ADD COLUMN cost_basis REAL` },
  { version: 102, name: 'reports', sql: `
    -- an imported report (pension, study fund, statement…): the file, what the AI read from it, and the review
    CREATE TABLE reports (
      id INTEGER PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      file TEXT NOT NULL,                  -- data/reports/<sha256>.<ext>
      original_name TEXT,
      issuer TEXT,
      report_type TEXT,
      as_of TEXT,
      status TEXT NOT NULL CHECK (status IN ('extracting','needs_review','applied','superseded','failed')),
      extraction TEXT,                     -- JSON, see src/reports/extract.ts
      questions TEXT,                      -- JSON [{ id, text, options? }]
      answers TEXT,                        -- JSON { [question id]: answer }
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      applied_at TEXT
    );

    -- every value point a report applied; a report holding is the latest point of its holding_source
    CREATE TABLE report_values (
      report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      holding_source TEXT NOT NULL,        -- report:<provider-slug>:<account>
      provider TEXT,
      product_type TEXT NOT NULL,
      account_number TEXT,                 -- digits only
      name TEXT,
      owner TEXT,
      balance REAL NOT NULL,
      currency TEXT NOT NULL,
      as_of TEXT NOT NULL,
      liquidity_date TEXT,
      PRIMARY KEY (report_id, holding_source)
    );
    CREATE INDEX idx_report_values_source ON report_values(holding_source, as_of);

    -- holdings.asset_class gains the long-term savings classes (a CHECK can only change with a table rebuild)
    CREATE TABLE holdings_new (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      quantity REAL NOT NULL,
      currency TEXT,
      asset_class TEXT NOT NULL CHECK (asset_class IN ('stock','crypto','stablecoin','broker_cash',
        'pension','study_fund','provident_fund','deposit','other')),
      broker TEXT,
      manual_price REAL,
      manual_price_date TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      cost_basis REAL,
      UNIQUE (source, symbol)
    );
    INSERT INTO holdings_new (id, source, symbol, name, quantity, currency, asset_class, broker, manual_price, manual_price_date,
      archived, synced_at, created_at, updated_at, cost_basis)
    SELECT id, source, symbol, name, quantity, currency, asset_class, broker, manual_price, manual_price_date,
      archived, synced_at, created_at, updated_at, cost_basis FROM holdings;
    DROP TABLE holdings;
    ALTER TABLE holdings_new RENAME TO holdings;
    CREATE INDEX idx_holdings_symbol ON holdings(symbol);
  ` },
  { version: 103, name: 'holdings.asset_class mutual_fund', sql: `
    -- holdings.asset_class gains mutual funds (קרנות נאמנות) from imported statements: a table rebuild, every row kept
    CREATE TABLE holdings_new (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      quantity REAL NOT NULL,
      currency TEXT,
      asset_class TEXT NOT NULL CHECK (asset_class IN ('stock','crypto','stablecoin','broker_cash',
        'pension','study_fund','provident_fund','deposit','other','mutual_fund')),
      broker TEXT,
      manual_price REAL,
      manual_price_date TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      cost_basis REAL,
      UNIQUE (source, symbol)
    );
    INSERT INTO holdings_new (id, source, symbol, name, quantity, currency, asset_class, broker, manual_price, manual_price_date,
      archived, synced_at, created_at, updated_at, cost_basis)
    SELECT id, source, symbol, name, quantity, currency, asset_class, broker, manual_price, manual_price_date,
      archived, synced_at, created_at, updated_at, cost_basis FROM holdings;
    DROP TABLE holdings;
    ALTER TABLE holdings_new RENAME TO holdings;
    CREATE INDEX idx_holdings_symbol ON holdings(symbol);
  ` },
  { version: 104, name: 'holdings.opened_at', sql: `
    -- when the current position was opened (IBKR openDateTime, the exchange's first buy / deposit, a wallet's first
    -- inbound transfer), and where cost_basis came from: broker (IBKR) | trades (average cost of the exchange's trades)
    ALTER TABLE holdings ADD COLUMN opened_at TEXT;
    ALTER TABLE holdings ADD COLUMN cost_basis_source TEXT;
  ` },
  { version: 105, name: 'report_values.returns', sql: `
    -- the returns a report prints for a product, JSON { ytd, m12, m36 } in % (each null when not printed)
    ALTER TABLE report_values ADD COLUMN returns TEXT;
  ` },
  { version: 106, name: 'merchant_categories', sql: `
    -- a merchant (merchantKey) → its category, decided once (src/categorize/); a low-confidence answer is cached too
    -- (as the "unknown" category, or NULL when there is none) so the merchant isn't asked again
    CREATE TABLE merchant_categories (
      merchant TEXT PRIMARY KEY,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      confidence REAL,
      source TEXT NOT NULL CHECK (source IN ('ai','rule')),
      model TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  ` },
];
const EXPECTED = [BASELINE_VERSION, ...STEPS.map(s => s.version)];

function applySteps(db: Database.Database, have: number[]): void {
  db.transaction(() => {
    for (const step of STEPS.filter(s => !have.includes(s.version))) {
      db.exec(step.sql);
      db.prepare(`INSERT INTO schema_version (version, name) VALUES (?, ?)`).run(step.version, step.name);
    }
  })();
}

const BASELINE = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,                 -- company:accountNumber
    company TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('bank','card')),
    display_name TEXT,
    card_frame REAL,
    currency TEXT DEFAULT 'ILS',
    is_savings INTEGER NOT NULL DEFAULT 0,
    is_debit INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    last_scraped_at TEXT
  );

  -- one row per account per scrape
  CREATE TABLE balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    balance REAL NOT NULL,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX idx_balances_account ON balances(account_id, id);

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES categories(id),
    kind TEXT NOT NULL DEFAULT 'expense'
      CHECK (kind IN ('expense','income','transfer','card_payment','savings'))
  );
  -- a scraper's own category name → ours
  CREATE TABLE category_aliases (
    name TEXT PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL UNIQUE,     -- dedup identity, see ingest/normalize.ts
    account_id TEXT NOT NULL REFERENCES accounts(id),
    date TEXT NOT NULL,                  -- purchase date (ISO)
    processed_date TEXT,                 -- charge/value date (ISO)
    description TEXT NOT NULL,
    memo TEXT,
    original_amount REAL NOT NULL,
    original_currency TEXT,
    charged_amount REAL NOT NULL,
    charged_currency TEXT DEFAULT 'ILS',
    status TEXT,                         -- completed | pending
    txn_type TEXT,                       -- normal | installments
    installment_number INTEGER,
    installment_total INTEGER,
    bank_identifier TEXT,
    source_category TEXT,                -- category supplied by the scraper
    category_id INTEGER REFERENCES categories(id),
    category_source TEXT,                -- scraper | ai | rule | manual
    kind TEXT,                           -- expense | income | refund | transfer | card_payment | savings
    kind_source TEXT,                    -- auto
    matched_txn_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    raw_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX idx_tx_account_date ON transactions(account_id, date);
  CREATE INDEX idx_tx_processed ON transactions(processed_date);
  CREATE INDEX idx_tx_description ON transactions(description);
  CREATE INDEX idx_tx_matched ON transactions(matched_txn_id);

  -- positions synced from a broker, wallet or exchange (src/sync/), and products from imported reports (src/reports/)
  CREATE TABLE holdings (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,                -- <source id>:<account>, e.g. ibkr:U1234567, wallets:0xabc…, binance:spot
    symbol TEXT NOT NULL,                -- Yahoo symbol when it has one (AAPL, TEVA.TA, BTC-USD), else the source's
    name TEXT,
    quantity REAL NOT NULL,
    currency TEXT,                       -- major units (ILS, not agorot)
    asset_class TEXT NOT NULL CHECK (asset_class IN ('stock','crypto','stablecoin','broker_cash')),
    broker TEXT,
    manual_price REAL,                   -- the source's own price, when there is no (agreeing) quote
    manual_price_date TEXT,
    archived INTEGER NOT NULL DEFAULT 0, -- gone from the source (restored when it comes back)
    synced_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source, symbol)
  );
  CREATE INDEX idx_holdings_symbol ON holdings(symbol);

  CREATE TABLE quotes (
    symbol TEXT PRIMARY KEY,
    name TEXT,
    currency TEXT,                       -- major units
    price REAL,
    previous_close REAL,
    exchange TEXT,
    instrument_type TEXT,
    market_time TEXT,
    fetched_at TEXT,
    error TEXT                           -- the last fetch failed: why (the price is the previous one)
  );

  CREATE TABLE fx_rates (
    date TEXT NOT NULL,
    currency TEXT NOT NULL,
    rate_to_ils REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'boi',  -- boi | yahoo (fills days BOI hasn't published; never overrides BOI)
    PRIMARY KEY (date, currency)
  );

  -- one row per bank / investment source per run
  CREATE TABLE source_runs (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    as_of TEXT                           -- the source's own data time
  );
  CREATE INDEX idx_source_runs ON source_runs(source, id);

  -- value per day, source and bucket (bank, cards_owed, or a holdings asset class), in ILS
  CREATE TABLE daily_snapshots (
    date TEXT NOT NULL,
    source TEXT NOT NULL,
    bucket TEXT NOT NULL,
    value_ils REAL NOT NULL,
    as_of TEXT,
    PRIMARY KEY (date, source, bucket)
  );
`;

/** Create the baseline in an empty database; refuse any other schema. */
export function ensureSchema(db: Database.Database): void {
  const hasVersions = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`).get();
  if (hasVersions) {
    const versions = db.prepare(`SELECT version FROM schema_version ORDER BY version`).pluck().all() as number[];
    if (versions.length && versions.every((v, i) => v === EXPECTED[i])) return applySteps(db, versions);
    throw new Error(`unsupported database schema (versions ${versions.join(', ') || 'none'}; expected ${EXPECTED.join(', ')}) — `
      + `this is not a FamilyCFO finance database. Point BANK_DB at a new file (default finance.db).`);
  }
  const tables = db.prepare(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'`).pluck().get() as number;
  if (tables > 0) throw new Error('the database has tables but no schema_version — refusing to use it');
  db.transaction(() => {
    db.exec(BASELINE);
    seedCategories(db);
    db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    db.prepare(`INSERT INTO schema_version (version, name) VALUES (?, 'baseline')`).run(BASELINE_VERSION);
  })();
  applySteps(db, [BASELINE_VERSION]);
}

/** The default category tree, with the card companies' own category names as aliases (Hebrew: they match scraped data). */
function seedCategories(db: Database.Database): void {
  const insert = db.prepare(`INSERT INTO categories (name, parent_id, kind) VALUES (?, ?, ?)`);
  for (const [name, kind, , , children] of DEFAULT_CATEGORIES) {
    const parentId = Number(insert.run(name, null, kind).lastInsertRowid);
    for (const [child, , , childKind] of children) insert.run(child, parentId, childKind ?? kind);
  }
  const alias = db.prepare(`INSERT OR IGNORE INTO category_aliases (name, category_id) SELECT ?, id FROM categories WHERE name = ?`);
  for (const [from, to] of Object.entries(SCRAPER_CATEGORY_ALIASES)) alias.run(from, to);
}

type CategoryKind = 'expense' | 'income' | 'transfer' | 'card_payment' | 'savings';
/** [name, kind, fixed by default, discretionary, children: [name, fixed, discretionary, kind if not the parent's]] */
const DEFAULT_CATEGORIES: [string, CategoryKind, number, number, [string, number, number, CategoryKind?][]][] = [
  ['אופנה ביגוד והנעלה', 'expense', 0, 1, []],
  ['אחר', 'expense', 0, 1, [['כרטיסים נטענים', 0, 0, 'transfer'], ['לא ידוע', 0, 1], ['קניות בחו"ל', 0, 1]]],
  ['ביטוחים', 'expense', 1, 1, []],
  ['בילוי ומסעדות', 'expense', 0, 1, [['אוכל מהיר', 0, 1], ['מסעדות ובילויים', 0, 1]]],
  ['בעלי חיים', 'expense', 0, 1, []],
  ['בריאות', 'expense', 0, 0, []],
  ['הכנסות', 'income', 0, 0, [['דיבידנדים', 0, 0], ['העברות חיצוניות', 0, 0], ['משכורת', 0, 0], ['עסק', 0, 0]]],
  ['הלוואות ומשכנתא', 'expense', 1, 0, []],
  ['העברות כספים', 'transfer', 0, 0, []],
  ['השקעות וחסכונות', 'savings', 0, 0, [['חסכון חודשי', 1, 0], ['תיק השקעות', 0, 0]]],
  ['תשלום כרטיס אשראי', 'card_payment', 0, 0, []],
  ['חינוך ומשפחה', 'expense', 0, 1, [['בתי ספר וגנים', 1, 0], ['חוגים', 1, 0], ['תרבות ופנאי', 0, 1]]],
  ['חשבונות', 'expense', 1, 0, [['אינטרנט', 1, 0], ['ארנונה', 1, 0], ['גז', 1, 0], ['ועד בית', 1, 0], ['חשמל', 1, 0], ['טלויזיה ובידור', 1, 0], ['מים', 1, 0], ['סלולר', 1, 0]]],
  ['חשמל ואלקטרוניקה', 'expense', 0, 1, []],
  ['מזומן', 'expense', 0, 1, []],
  ['מזון וטואלטיקה', 'expense', 0, 0, [['חד פעמי', 0, 0], ['סופרמרקט', 0, 0], ['פארם', 0, 0], ['פירות וירקות', 0, 0]]],
  ['מיסים, דוחות ועמלות', 'expense', 0, 0, [['עמלות אשראי', 1, 0], ['עמלות בנק', 1, 0], ['תשלום דוחות', 0, 0]]],
  ['מנויים ושירותים דיגיטליים', 'expense', 1, 0, []],
  ['נופש', 'expense', 0, 1, [['אטרקציות', 0, 1], ['טיסות', 0, 1], ['כסף מזומן', 0, 1], ['מחייה ומזון', 0, 1], ['מלונות', 0, 1], ['שופינג', 0, 1], ['תחבורה', 0, 1], ['תקשורת', 0, 1]]],
  ['ספורט וטיפוח', 'expense', 0, 1, [['מנוי כושר', 1, 1], ['מספרה', 0, 1], ['קוסמטיקה ואביזרי טיפוח', 0, 1]]],
  ['רכב ותחבורה', 'expense', 0, 0, [['ביטוח רכב', 1, 0], ['דלק וחשמל', 0, 0], ['הלוואת רכב', 1, 0], ['חניונים', 0, 1], ['תחבורה ציבורית', 0, 0], ['תחזוקת רכב', 0, 0]]],
  ['שיפוץ, תחזוקה וריהוט הבית', 'expense', 0, 1, [['ניקיון', 0, 1], ['ריהוט', 0, 1], ['שיפוץ ואביזרים לבית', 0, 1], ['תיקונים', 0, 0]]],
  ['תרומות ומתנות', 'expense', 0, 1, [['מתנות ואירועים', 0, 1], ['תרומה', 0, 1]]],
];

/** Category names Max / Isracard / Cal put on their rows → the default category they mean. */
const SCRAPER_CATEGORY_ALIASES: Record<string, string> = {
  'מזון וצריכה': 'סופרמרקט', 'מזון ומשקאות': 'סופרמרקט', 'מסעדות, קפה וברים': 'מסעדות ובילויים', 'מסעדות': 'מסעדות ובילויים',
  'מזון מהיר': 'אוכל מהיר', 'אופנה': 'אופנה ביגוד והנעלה', 'רפואה ובתי מרקחת': 'פארם', 'רפואה ובריאות': 'בריאות',
  'שירותי תקשורת': 'סלולר', 'ביטוח': 'ביטוחים', 'דלק, חשמל וגז': 'דלק וחשמל', 'אנרגיה': 'דלק וחשמל',
  'תחבורה ורכבים': 'רכב ותחבורה', 'חיות מחמד': 'בעלי חיים', 'קוסמטיקה וטיפוח': 'קוסמטיקה ואביזרי טיפוח',
  'מלונאות ואירוח': 'מלונות', 'טיסות ותיירות': 'טיסות', 'תיירות': 'נופש', 'תקשורת ומחשבים': 'חשמל ואלקטרוניקה',
  'חשמל ומחשבים': 'חשמל ואלקטרוניקה', 'ריהוט ובית': 'ריהוט', 'עיצוב הבית': 'שיפוץ ואביזרים לבית', 'ספרים ודפוס': 'תרבות ופנאי',
  'אירועים': 'מתנות ואירועים', 'ילדים': 'חינוך ומשפחה', 'פנאי, בידור וספורט': 'תרבות ופנאי', 'פנאי בילוי': 'מסעדות ובילויים',
};
