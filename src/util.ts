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
const isLoneLetter = (tok: string | undefined) => tok != null && [...tok].length === 1;

/** A municipality: the city after it is the payee, not a tail. */
const MUNICIPALITY = new Set(['עיריית', 'עירית', 'עיריה']);
/** One city's spellings on statements (as tokens) → the one spelling; longest first. */
const CITY_SPELLINGS: [string[], string[]][] = [
  [['תל', 'אביב', 'יפו'], ['תל', 'אביב']], [['ת', 'א', 'יפו'], ['תל', 'אביב']], [['תא', 'יפו'], ['תל', 'אביב']],
  [['ת', 'א'], ['תל', 'אביב']], [['תא'], ['תל', 'אביב']],
];

/**
 * A municipality's merchant: "עיריית <city>", the city spelled one way ("ת"א", "תא יפו", "תל אביב-יפו" → תל אביב);
 * ארנונה (its default charge — cut to a lone "א" by Isracard) dropped, other services (חניה) kept apart.
 */
function municipalityKey(tokens: string[]): string {
  let rest = tokens.slice(1);
  const spelling = CITY_SPELLINGS.find(([from]) => from.every((t, i) => rest[i] === t));
  if (spelling) rest = [...spelling[1], ...rest.slice(spelling[0].length)];
  rest = rest.filter(t => t !== 'ארנונה').map(t => (t === 'חנייה' ? 'חניה' : t));
  if (rest.length > 1 && isLoneLetter(rest.at(-1))) rest = rest.slice(0, -1);
  return ['עיריית', ...rest].join(' ');
}

/**
 * The merchant, for grouping: the first line of the description, lower-cased, without punctuation, reference numbers,
 * card suffixes (a number, or a token with 3+ digits — G2A and CHEF4 stay), a bank's "חיוב מ-" prefix, a company form (בע"מ, Ltd) or a city tail
 * ("… תל אביב", "… נתבג", a lone trailing letter) — as long as a name is left. A municipality keeps its city (`municipalityKey`).
 */
export function merchantKey(description: string): string {
  let tokens = description
    .split(/\r?\n/)[0]
    .replace(/^\s*חיוב מ-\s*/, '')
    .toLowerCase()
    .replace(/[*"'`״׳.,()\-–_/\\|#?]+/g, ' ')
    .split(/\s+/)
    .filter(tok => tok && !/^\d+$/.test(tok) && (tok.match(/\d/g)?.length ?? 0) < 3);
  if (tokens.length > 1 && MUNICIPALITY.has(tokens[0])) return municipalityKey(tokens);
  for (let changed = true; changed;) {
    changed = false;
    for (const tail of [...COMPANY_TAILS, ...CITY_TAILS, ...(tokens.length > 1 && isLoneLetter(tokens.at(-1)) ? [[tokens.at(-1)!]] : [])]) {
      if (endsWith(tokens, tail)) { tokens = tokens.slice(0, -tail.length); changed = true; break; }
    }
  }
  return tokens.join(' ').trim() || description.trim().toLowerCase();
}

/** A Bit transfer's line: Isracard "העברה בBIT", Cal "העברה ב BIT בנה"פ", the banks' "הפועלים-ביט/<name>…" (not מוביט, Bit2C). */
const BIT_PATTERN = /^העברה ב\s?bit(?=$|[\s\-*/.])|(?:^|[\s\-])(?:ביט|bit)(?=$|[\s\-*/.])/i;
/** The other side of a Bit transfer: Cal's memo "העברה ל<name>" / "העברת כספים ל<name>", a bank's "ביט/<name>". */
function bitCounterparty(description: string, memo: string | null | undefined): string | null {
  const m = memo?.match(/העבר(?:ה|ת כספים) ל-?\s*(\S.*)/) ?? description.match(/(?:ביט|bit)\s*\/\s*([^./]+)/i);
  return m?.[1].replace(/\s+/g, ' ').trim() || null;
}

/**
 * The line a row's merchant is read from (`merchantKey`, `cleanMerchantName`): its description, except a Bit transfer —
 * "Bit – <name>" when the memo or the line names the other side, else "Bit".
 */
export function merchantLine(description: string, memo?: string | null): string {
  if (!BIT_PATTERN.test(description.split(/\r?\n/)[0])) return description;
  const who = bitCounterparty(description, memo);
  return who ? `Bit – ${who}` : 'Bit';
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
