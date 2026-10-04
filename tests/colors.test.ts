import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { SOURCE_COLORS, SOURCE_OTHER, sourceColor } from '../web/src/colors.js';

const css = readFileSync(new URL('../web/src/index.css', import.meta.url), 'utf8');
const tokens = new Map([...css.matchAll(/--color-src-([a-z]+):\s*(#[0-9a-f]{6})/gi)].map(m => [`var(--color-src-${m[1]})`, m[2].toLowerCase()]));

/** WCAG relative luminance contrast against white. */
const contrastOnWhite = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
};

describe('source colours', () => {
  it('every source has its own token, no two the same', () => {
    const used = [...Object.values(SOURCE_COLORS), SOURCE_OTHER];
    expect(new Set(used).size).toBe(used.length);
    const hexes = used.map(v => tokens.get(v));
    expect(hexes.every(Boolean)).toBe(true);
    expect(new Set(hexes).size).toBe(hexes.length);
    for (const s of ['oneZero', 'hapoalim', 'otsarHahayal', 'isracard', 'max', 'ibkr', 'binance', 'kraken', 'wallets', 'report']) expect(SOURCE_COLORS[s]).toBeDefined();
  });
  it('each reads on the light background (≥ 3:1)', () => {
    for (const hex of tokens.values()) expect(contrastOnWhite(hex)).toBeGreaterThanOrEqual(3);
  });
  it('maps accounts, report products and unknown sources', () => {
    expect(sourceColor('isracard:1234')).toBe(SOURCE_COLORS.isracard);
    expect(sourceColor('report:provider:1')).toBe(SOURCE_COLORS.report);
    expect(sourceColor('leumi')).toBe(SOURCE_OTHER);
  });
});
