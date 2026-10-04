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
