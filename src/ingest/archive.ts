import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

/** Where untouched scrape / sync payloads are kept (git-ignored with the rest of `data/`). `RAW_DIR` overrides. */
export const RAW_DIR = resolve(process.env.RAW_DIR ?? join('data', 'raw'));

/**
 * Keep the payload exactly as the source returned it, before anything is normalized: when the parsing or the schema
 * changes, past runs can be re-derived from it (holdings keep only the current position, so this is their history too).
 * `data/raw/<source>/<timestamp>.json`. Never throws — a full disk shouldn't fail the scrape.
 */
export function archiveRaw(source: string, payload: unknown, at = new Date()): string | null {
  try {
    const dir = join(RAW_DIR, source.replace(/[^\w.-]+/g, '_'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${at.toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(path, JSON.stringify(payload, null, 2));
    return path;
  } catch (err) {
    console.warn(`  raw payload of ${source} not archived:`, (err as Error).message);
    return null;
  }
}
