import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { SCRAPERS } from 'israeli-bank-scrapers';
import { BANK_COMPANIES, SOURCE_NAMES } from '../db/ingestRepo.js';
import type { Config } from '../scraper.js';
import { investmentSourceId, type InvestmentSource } from '../sync/index.js';

/**
 * Add / edit / disable / remove the sources in accounts.json from the dashboard. Secrets never leave this module
 * unmasked: listings carry only whether a field is filled and its last 4 characters. Every write backs the file up first.
 */

export type IntegrationType = 'bank' | 'ibkr' | 'exchange' | 'wallets';
export interface FieldSpec { name: string; label: string; secret: boolean; optional?: boolean }

const LABELS: Record<string, string> = {
  userCode: 'User code', username: 'Username', password: 'Password', id: 'ID number', num: 'Code', card6Digits: 'Card 6 digits',
  nationalID: 'National ID', email: 'Email', phoneNumber: 'Phone number (+972…)', token: 'Flex token', queryId: 'Flex query ID',
  apiKey: 'API key', secret: 'API secret',
};
/** Login fields the scraper defines that are not typed in: One Zero's code callback and its expiring OTP token. */
const NOT_TYPED = new Set(['otpCodeRetriever', 'otpLongTermToken']);
const field = (name: string, optional = false): FieldSpec => ({ name, label: LABELS[name] ?? name, secret: true, optional });

/** Every company israeli-bank-scrapers supports, with its login fields; then the investment source types. */
export function catalog() {
  return {
    banks: Object.entries(SCRAPERS as Record<string, { name: string; loginFields: string[] }>).map(([id, d]) => ({
      id, name: SOURCE_NAMES[id] ?? d.name, kind: BANK_COMPANIES.has(id) ? 'bank' as const : 'card' as const,
      fields: d.loginFields.filter(f => !NOT_TYPED.has(f)).map(f => field(f)),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    ibkr: { fields: [field('token'), field('queryId')] },
    exchange: { suggestions: ['binance', 'kraken'], fields: [field('apiKey'), field('secret'), { ...field('password', true), label: 'API passphrase' }] },
    wallets: { fields: [field('apiKey')], networks: ['eth-mainnet', 'arb-mainnet', 'base-mainnet', 'opt-mainnet', 'polygon-mainnet'] },
  };
}

const bankFields = (companyId: string) => catalog().banks.find(b => b.id === companyId)?.fields;
const fieldsOf = (type: IntegrationType, companyId?: string): FieldSpec[] | undefined =>
  type === 'bank' ? bankFields(companyId ?? '') : catalog()[type].fields;

/** "••••1234": the last 4 characters of a long enough value, nothing of a short one. */
export const mask = (v: string) => (v.length >= 8 ? `••••${v.slice(-4)}` : '••••');
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !/^YOUR_/.test(v.trim());

type AccountEntry = Config['accounts'][number] & { disabled?: boolean };
type InvestmentEntry = InvestmentSource & { disabled?: boolean };

export const keyOf = (section: 'accounts' | 'investments', id: string) => `${section}:${id}`;

/** The integrations in the file, secrets masked. */
export function listIntegrations(config: Config) {
  const masked = (entry: Record<string, unknown>, specs: FieldSpec[]) => Object.fromEntries(specs.map(f => {
    const v = entry[f.name];
    return [f.name, filled(v) ? { filled: true, masked: mask(v) } : { filled: false, masked: null }];
  }));
  const banks = (config.accounts ?? []).map(raw => {
    const a = raw as AccountEntry;
    const id = String(a.companyId);
    const specs = bankFields(id) ?? Object.keys(a.credentials ?? {}).map(f => field(f));
    return {
      key: keyOf('accounts', id), type: 'bank' as const, id, companyId: id, label: SOURCE_NAMES[id] ?? id, disabled: !!a.disabled,
      fields: masked(a.credentials ?? {}, specs),
      ...(id === 'oneZero' ? { linked: filled(a.credentials?.idToken) } : {}),
    };
  });
  const investments = (config.investments ?? []).map(raw => {
    const s = raw as InvestmentEntry;
    const id = investmentSourceId(s);
    const base = { key: keyOf('investments', id), type: s.type as IntegrationType, id, label: SOURCE_NAMES[id] ?? id, disabled: !!s.disabled,
      fields: masked(s as unknown as Record<string, unknown>, catalog()[s.type as 'ibkr' | 'exchange' | 'wallets']?.fields ?? []) };
    if (s.type === 'exchange') return { ...base, exchange: s.exchange };
    if (s.type === 'wallets') return { ...base, networks: s.networks ?? ['eth-mainnet'], wallets: s.wallets ?? [] };
    return base;
  });
  return [...banks, ...investments];
}

/** What the form sends: field values (blank = keep the current one when editing), plus the type's own settings. */
export interface Draft {
  type: IntegrationType;
  companyId?: string;
  exchange?: string;
  fields?: Record<string, string>;
  networks?: string[];
  wallets?: { address: string; label?: string }[];
}

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const clean = (fields: Record<string, unknown> = {}) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v !== '')) as Record<string, string>;

function findEntry(config: Config, key: string): { section: 'accounts' | 'investments'; index: number } | null {
  const [section, ...rest] = key.split(':');
  const id = rest.join(':');
  if (section === 'accounts') {
    const index = (config.accounts ?? []).findIndex(a => String(a.companyId) === id);
    return index < 0 ? null : { section, index };
  }
  if (section === 'investments') {
    const index = (config.investments ?? []).findIndex(s => investmentSourceId(s) === id);
    return index < 0 ? null : { section, index };
  }
  return null;
}

/**
 * The config with `draft` applied: added (no `key`) or merged into the integration at `key` — a blank field keeps the
 * current value, keys the form doesn't know (e.g. ownerMemberId, idToken) are kept. Returns the new config and the key.
 */
export function applyDraft(config: Config, draft: Draft, key?: string): { config: Config; key: string } {
  const next: Config = JSON.parse(JSON.stringify(config ?? {}));
  next.accounts ??= [];
  const values = clean(draft.fields);
  const at = key ? findEntry(next, key) : null;
  if (key && !at) throw Object.assign(new Error('no such integration'), { statusCode: 404 });
  const specs = fieldsOf(draft.type, draft.companyId);
  if (!specs) throw bad(`unknown integration ${draft.type === 'bank' ? `company "${draft.companyId}"` : `type "${draft.type}"`}`);
  const allowed = new Set(specs.map(f => f.name));
  for (const k of Object.keys(values)) if (!allowed.has(k)) throw bad(`unknown field "${k}"`);
  const requireAll = (entry: Record<string, unknown>) => {
    const missing = specs.filter(f => !f.optional && !filled(entry[f.name])).map(f => f.label);
    if (missing.length) throw bad(`missing: ${missing.join(', ')}`);
  };

  if (draft.type === 'bank') {
    const companyId = String(draft.companyId);
    if (at && at.section !== 'accounts') throw bad('type mismatch');
    if (!at && next.accounts.some(a => String(a.companyId) === companyId)) throw bad(`${companyId} is already set up`);
    const entry = (at ? next.accounts[at.index] : { companyId, credentials: {} }) as AccountEntry;
    entry.credentials = { ...(entry.credentials ?? {}), ...values };
    requireAll(entry.credentials);
    if (!at) next.accounts.push(entry as Config['accounts'][number]);
    return { config: next, key: keyOf('accounts', companyId) };
  }

  next.investments ??= [];
  if (at && at.section !== 'investments') throw bad('type mismatch');
  const existing = at ? next.investments[at.index] as unknown as Record<string, unknown> : null;
  if (existing && existing.type !== draft.type) throw bad('type mismatch');
  const entry: Record<string, unknown> = existing ?? { type: draft.type };
  Object.assign(entry, values);
  if (draft.type === 'exchange') {
    const exchange = (draft.exchange ?? (entry.exchange as string | undefined) ?? '').trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(exchange)) throw bad('exchange must be a ccxt id, e.g. binance');
    entry.exchange = exchange;
  }
  if (draft.type === 'wallets') {
    if (draft.networks) entry.networks = draft.networks.map(n => n.trim()).filter(Boolean);
    if (draft.wallets) {
      const wallets = draft.wallets.map(w => ({ address: w.address.trim(), ...(w.label?.trim() ? { label: w.label.trim() } : {}) })).filter(w => w.address);
      for (const w of wallets) if (!/^0x[0-9a-fA-F]{40}$/.test(w.address)) throw bad(`not an EVM address: ${w.address}`);
      entry.wallets = wallets;
    }
    if (!(entry.wallets as unknown[] | undefined)?.length) throw bad('add at least one wallet address');
  }
  requireAll(entry);
  const source = entry as unknown as InvestmentSource;
  if (!existing) {
    // a second account of the same type/exchange gets an id of its own
    let id = investmentSourceId(source);
    for (let n = 2; next.investments.some(s => investmentSourceId(s) === id); n++) id = `${investmentSourceId({ ...source, id: undefined })}-${n}`;
    if (id !== investmentSourceId(source)) entry.id = id;
    next.investments.push(source);
  }
  return { config: next, key: keyOf('investments', investmentSourceId(source)) };
}

/** The config with only the integration at `key` (for a one-source test run), enabled. */
export function onlyEntry(config: Config, key: string): Config {
  const at = findEntry(config, key);
  if (!at) throw Object.assign(new Error('no such integration'), { statusCode: 404 });
  const { disabled: _off, ...entry } = config[at.section]![at.index] as unknown as Record<string, unknown>;
  return at.section === 'accounts'
    ? { accounts: [entry as unknown as Config['accounts'][number]], investments: [] }
    : { accounts: [], investments: [entry as unknown as InvestmentSource] };
}

export function setDisabled(config: Config, key: string, disabled: boolean): Config {
  const next: Config = JSON.parse(JSON.stringify(config));
  const at = findEntry(next, key);
  if (!at) throw Object.assign(new Error('no such integration'), { statusCode: 404 });
  const entry = next[at.section]![at.index] as { disabled?: boolean };
  if (disabled) entry.disabled = true; else delete entry.disabled;
  return next;
}

export function removeEntry(config: Config, key: string): { config: Config; source: string; section: 'accounts' | 'investments' } {
  const next: Config = JSON.parse(JSON.stringify(config));
  const at = findEntry(next, key);
  if (!at) throw Object.assign(new Error('no such integration'), { statusCode: 404 });
  (next[at.section] as unknown[]).splice(at.index, 1);
  return { config: next, source: key.slice(key.indexOf(':') + 1), section: at.section };
}

export function readConfigFile(path: string): Config {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) as Config : { accounts: [], investments: [] };
}

/** Back the current file up (data/backups/accounts-<time>.json, 600), then write atomically and keep the file at 600. */
export function writeConfigFile(path: string, config: Config, backupDir = process.env.BACKUPS_DIR || join('data', 'backups')): string | null {
  let backup: string | null = null;
  if (existsSync(path)) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    backup = join(backupDir, `accounts-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
  }
  const tmp = join(dirname(path) || '.', `.accounts-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return backup;
}
