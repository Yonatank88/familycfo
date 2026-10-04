/** Today's calendar date in Israel (YYYY-MM-DD). */
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

// a city (or the airport) the card company appends after the merchant's name, as tokens; longest first
const CITY_TAILS = [
  'תל אביב יפו', 'ת א יפו', 'ראשון לציון', 'פתח תקווה', 'פתח תקוה', 'תל אביב', 'רמת גן', 'בת ים', 'באר שבע', 'כפר סבא', 'הוד השרון',
  'רמת השרון', 'בני ברק', 'ת א', 'ירושלים', 'חיפה', 'הרצליה', 'גבעתיים', 'נתניה', 'רעננה', 'חולון', 'אשדוד', 'רחובות', 'מודיעין',
  'יפו', 'נתבג', 'tel aviv', 'jerusalem', 'herzliya', 'haifa',
].map(c => c.split(' ')).sort((a, b) => b.length - a.length);
// a company-form suffix, as tokens (בע"מ arrives as "בע מ" once the quote is gone)
const COMPANY_TAILS = [['בע', 'מ'], ['בעמ'], ['ltd'], ['inc'], ['llc'], ['bv'], ['b', 'v'], ['gmbh']];

const endsWith = (tokens: string[], tail: string[]) =>
  tokens.length > tail.length && tail.every((t, i) => tokens[tokens.length - tail.length + i] === t);

/**
 * The merchant, for grouping: the first line of the description, lower-cased, without punctuation, reference numbers,
 * card suffixes (a number, or a token with 3+ digits — G2A and CHEF4 stay), a bank's "חיוב מ-" prefix, a company form (בע"מ, Ltd) or a city tail
 * ("… תל אביב", "… נתבג", a lone trailing letter) — as long as a name is left.
 */
export function merchantKey(description: string): string {
  let tokens = description
    .split(/\r?\n/)[0]
    .replace(/^\s*חיוב מ-\s*/, '')
    .toLowerCase()
    .replace(/[*"'`״׳.,()\-–_/\\|#?]+/g, ' ')
    .split(/\s+/)
    .filter(tok => tok && !/^\d+$/.test(tok) && (tok.match(/\d/g)?.length ?? 0) < 3);
  for (let changed = true; changed;) {
    changed = false;
    for (const tail of [...COMPANY_TAILS, ...CITY_TAILS, ...(tokens.length > 1 && [...tokens.at(-1)!].length === 1 ? [[tokens.at(-1)!]] : [])]) {
      if (endsWith(tokens, tail)) { tokens = tokens.slice(0, -tail.length); changed = true; break; }
    }
  }
  return tokens.join(' ').trim() || description.trim().toLowerCase();
}

/** "••1234": the last 4 digits of an account / card number, the one way they are shown. */
export const maskLast4 = (number: string | null | undefined) => {
  const digits = String(number ?? '').replace(/\D/g, '');
  return digits ? `••${digits.slice(-4)}` : '';
};

/**
 * A merchant's name as shown: card-statement noise removed — a numeric reference before or after the name
 * ("12345678/ACME", "ACME/1234", "ACME 456", "4521 - ACME"), the installment note on a second line, stray separators.
 */
export function cleanMerchantName(description: string): string {
  const name = description
    .split(/\r?\n/)[0]
    .replace(/^(?:\d{3,}\s*[/\-–]\s*)+/, '')
    .replace(/(?:\s*[\s/\-–]\s*\d{3,})+$/, '')
    .replace(/\/\d+$/, '')
    .replace(/^[\s/\-–*|]+|[\s/\-–*|]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return name || description.trim();
}
