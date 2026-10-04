/** Today's calendar date in Israel (YYYY-MM-DD). */
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** A description without punctuation, codes and numbers — the merchant, for grouping. */
export function merchantKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/[*"'`.,()\-_/\\|#]+/g, ' ')
    .split(/\s+/)
    .filter(tok => tok && !/\d/.test(tok))
    .join(' ')
    .trim() || description.trim().toLowerCase();
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
