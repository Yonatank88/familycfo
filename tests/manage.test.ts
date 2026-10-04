import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyDraft, catalog, listIntegrations, mask, onlyEntry, readConfigFile, removeEntry, setDisabled, writeConfigFile } from '../src/integrations/manage.js';
import { configuredSources, integrationStatus } from '../src/analytics/integrations.js';

// a temporary ACCOUNTS_FILE: never the real one
function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'familycfo-accounts-'));
  return { dir, file: join(dir, 'accounts.json'), backups: join(dir, 'backups'), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const SECRET = 'pw-0123456789-abcd';
const save = (t: ReturnType<typeof tempFile>, c: Parameters<typeof writeConfigFile>[1]) => writeConfigFile(t.file, c, t.backups);

describe('integrations in accounts.json', () => {
  it('lists every israeli-bank-scrapers company with its typed login fields', () => {
    const banks = catalog().banks;
    expect(banks.find(b => b.id === 'hapoalim')?.fields.map(f => f.name)).toEqual(['userCode', 'password']);
    expect(banks.find(b => b.id === 'oneZero')?.fields.map(f => f.name)).toEqual(['email', 'password', 'phoneNumber']);
    expect(banks.find(b => b.id === 'max')?.kind).toBe('card');
  });

  it('adds, masks, edits with blank-keeps, disables, removes — backing the file up before every write, at 600', () => {
    const t = tempFile();
    try {
      writeFileSync(t.file, JSON.stringify({ accounts: [], investments: [{ type: 'ibkr', token: 'tok-AAAA-1111', queryId: '99887766', ownerMemberId: 'm1' }] }));
      // add a bank
      let { config, key } = applyDraft(readConfigFile(t.file), { type: 'bank', companyId: 'hapoalim', fields: { userCode: 'AB12345', password: SECRET } });
      expect(save(t, config)).toMatch(/accounts-.*\.json$/);
      expect(key).toBe('accounts:hapoalim');
      expect(statSync(t.file).mode & 0o777).toBe(0o600);
      expect(readdirSync(t.backups)).toHaveLength(1);
      expect(statSync(join(t.backups, readdirSync(t.backups)[0])).mode & 0o777).toBe(0o600);

      // the listing never carries a secret: filled + last 4 (nothing of a short value)
      const listed = listIntegrations(readConfigFile(t.file));
      expect(JSON.stringify(listed)).not.toContain(SECRET);
      expect(JSON.stringify(listed)).not.toContain('AB12345');
      expect(listed.find(x => x.key === 'accounts:hapoalim')!.fields).toEqual({
        userCode: { filled: true, masked: '••••' }, // shorter than 8: nothing shown
        password: { filled: true, masked: mask(SECRET) },
      });
      expect(mask(SECRET)).toBe('••••abcd');

      // edit: a blank field keeps its value, a typed one replaces it, unknown keys (ownerMemberId) stay
      ({ config } = applyDraft(readConfigFile(t.file), { type: 'bank', companyId: 'hapoalim', fields: { userCode: 'ZZ99999', password: '' } }, 'accounts:hapoalim'));
      ({ config } = applyDraft(config, { type: 'ibkr', fields: { token: '', queryId: '11223344' } }, 'investments:ibkr'));
      save(t, config);
      const file = readConfigFile(t.file);
      expect(file.accounts[0].credentials).toEqual({ userCode: 'ZZ99999', password: SECRET });
      expect(file.investments![0]).toMatchObject({ token: 'tok-AAAA-1111', queryId: '11223344', ownerMemberId: 'm1' });
      expect(readdirSync(t.backups)).toHaveLength(2);

      // disable: kept in the file, status Disabled, left out of a test's one-entry config flag
      save(t, setDisabled(readConfigFile(t.file), 'accounts:hapoalim', true));
      expect(configuredSources(readConfigFile(t.file))[0]).toMatchObject({ id: 'hapoalim', disabled: true });
      expect(integrationStatus({ configured: true, disabled: true, lastRunOk: true, lastSuccessAt: new Date().toISOString() })).toBe('disabled');
      expect(onlyEntry(readConfigFile(t.file), 'accounts:hapoalim')).toEqual({ accounts: [{ companyId: 'hapoalim', credentials: file.accounts[0].credentials }], investments: [] });

      // remove
      const removed = removeEntry(readConfigFile(t.file), 'accounts:hapoalim');
      save(t, removed.config);
      expect(removed).toMatchObject({ source: 'hapoalim', section: 'accounts' });
      expect(readConfigFile(t.file).accounts).toEqual([]);
      expect(readdirSync(t.backups)).toHaveLength(4);
      expect(statSync(t.file).mode & 0o777).toBe(0o600);
      // the first backup is the file as it was before the first write
      expect(JSON.parse(readFileSync(join(t.backups, readdirSync(t.backups).sort()[0]), 'utf-8')).accounts).toEqual([]);
    } finally {
      t.done();
    }
  });

  it('validates: required fields on add, duplicates, unknown fields, wallet addresses; a second exchange gets its own id', () => {
    const empty = { accounts: [], investments: [] };
    expect(() => applyDraft(empty, { type: 'bank', companyId: 'hapoalim', fields: { userCode: 'x' } })).toThrow(/missing: Password/);
    expect(() => applyDraft(empty, { type: 'bank', companyId: 'nope', fields: {} })).toThrow(/unknown integration/);
    expect(() => applyDraft(empty, { type: 'ibkr', fields: { token: 'a', queryId: 'b', evil: 'c' } })).toThrow(/unknown field/);
    expect(() => applyDraft(empty, { type: 'wallets', fields: { apiKey: 'k' }, wallets: [{ address: '0x12' }] })).toThrow(/not an EVM address/);
    const one = applyDraft(empty, { type: 'exchange', exchange: 'Kraken', fields: { apiKey: 'k', secret: 's' } });
    expect(one.key).toBe('investments:kraken');
    const two = applyDraft(one.config, { type: 'exchange', exchange: 'kraken', fields: { apiKey: 'k2', secret: 's2' } });
    expect(two.key).toBe('investments:kraken-2');
    expect(() => applyDraft(two.config, { type: 'bank', companyId: 'max', fields: { username: 'u', password: 'p' } })).not.toThrow();
    const w = applyDraft(empty, { type: 'wallets', fields: { apiKey: 'alchemy-key' }, networks: ['eth-mainnet', ' base-mainnet '],
      wallets: [{ address: '0x' + 'a'.repeat(40), label: 'Main' }] });
    expect(w.config.investments![0]).toEqual({ type: 'wallets', apiKey: 'alchemy-key', networks: ['eth-mainnet', 'base-mainnet'],
      wallets: [{ address: '0x' + 'a'.repeat(40), label: 'Main' }] });
  });
});
