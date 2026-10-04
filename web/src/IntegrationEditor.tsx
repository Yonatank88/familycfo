import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Catalog, type ConfigEntry, type Draft, type FieldSpec, type IntegrationType } from './api';
import { useScrape } from './Layout';
import { SidePanel, Tip, button, primaryButton } from './ui';

export type EditorMode = { kind: 'add' } | { kind: 'edit'; key: string };

const input = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent';
const label = 'mb-1 block text-xs font-medium text-muted';

function fieldsFor(catalog: Catalog, draft: Draft): FieldSpec[] {
  if (draft.type === 'bank') return catalog.banks.find(b => b.id === draft.companyId)?.fields ?? [];
  return catalog[draft.type].fields;
}

function titleOf(catalog: Catalog, draft: Draft) {
  if (draft.type === 'bank') return catalog.banks.find(b => b.id === draft.companyId)?.name ?? draft.companyId;
  return { ibkr: 'IBKR Flex', exchange: 'Exchange', wallets: 'ETH wallets' }[draft.type];
}

function Picker({ catalog, onPick }: { catalog: Catalog; onPick: (d: Draft) => void }) {
  const item = 'flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-left text-sm text-ink hover:border-accent/40 hover:bg-accent/5';
  const investments: { type: IntegrationType; name: string; sub: string }[] = [
    { type: 'ibkr', name: 'IBKR Flex', sub: 'Broker' },
    { type: 'exchange', name: 'Exchange', sub: 'Binance, Kraken, any ccxt id' },
    { type: 'wallets', name: 'ETH wallets', sub: 'Alchemy' },
  ];
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Investments</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {investments.map(x => (
            <button key={x.type} type="button" className={item} onClick={() => onPick({ type: x.type, fields: {}, ...(x.type === 'wallets' ? { networks: ['eth-mainnet'], wallets: [{ address: '', label: '' }] } : {}) })}>
              <span>{x.name}</span><span className="truncate text-xs text-faint">{x.sub}</span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Banks & cards</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {catalog.banks.map(b => (
            <button key={b.id} type="button" className={item} onClick={() => onPick({ type: 'bank', companyId: b.id, fields: {} })}>
              <span>{b.name}</span><span className="text-xs text-faint">{b.kind === 'bank' ? 'Bank' : 'Card'}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function OneZeroLink({ linked }: { linked: boolean }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<'idle' | 'sending' | 'code' | 'linking' | 'done'>('idle');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError((e as Error).message);
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">SMS link</span>
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${linked || step === 'done' ? 'bg-up/10 text-up' : 'bg-warn/15 text-warn'}`}>
          {linked || step === 'done' ? 'Linked' : 'Not linked'}
        </span>
      </div>
      {step === 'code' || step === 'linking' ? (
        <form className="mt-3 flex items-center gap-2" onSubmit={e => {
          e.preventDefault(); setError(null); setStep('linking');
          api.linkCode('onezero', code).then(() => { setStep('done'); qc.invalidateQueries({ queryKey: ['integration-config'] }); })
            .catch(e => { fail(e); setStep('code'); });
        }}>
          <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Code"
            className={`${input} w-32`} />
          <button type="submit" disabled={step === 'linking' || !code.trim()} className={primaryButton}>{step === 'linking' ? 'Linking…' : 'Link'}</button>
        </form>
      ) : step !== 'done' && (
        <button type="button" disabled={step === 'sending'} className={`${button} mt-3`} onClick={() => {
          setError(null); setStep('sending');
          api.linkStart('onezero').then(() => setStep('code')).catch(e => { fail(e); setStep('idle'); });
        }}>{step === 'sending' ? 'Sending…' : linked ? 'Send a new code' : 'Send code'}</button>
      )}
      {error && <p className="mt-2 text-xs text-down">{error}</p>}
    </section>
  );
}

export default function IntegrationEditor({ mode, onClose }: { mode: EditorMode; onClose: () => void }) {
  const qc = useQueryClient();
  const scrape = useScrape();
  const { data } = useQuery({ queryKey: ['integration-config'], queryFn: api.integrationConfig });
  const entry: ConfigEntry | undefined = mode.kind === 'edit' ? data?.integrations.find(x => x.key === mode.key) : undefined;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testKey, setTestKey] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [keepData, setKeepData] = useState(true);

  useEffect(() => {
    if (entry && !draft) setDraft({ type: entry.type, companyId: entry.companyId, exchange: entry.exchange, fields: {}, networks: entry.networks, wallets: entry.wallets });
  }, [entry, draft]);

  const refresh = () => qc.invalidateQueries({ predicate: q => q.queryKey[0] !== 'scrape' });
  const run = (p: Promise<unknown>, close = true) => {
    setBusy(true); setError(null);
    return p.then(() => { refresh(); if (close) onClose(); }).catch(e => setError((e as Error).message)).finally(() => setBusy(false));
  };
  const key = mode.kind === 'edit' ? mode.key : undefined;
  const save = () => draft && run(key ? api.editIntegration(key, draft) : api.addIntegration(draft));
  const test = () => {
    if (!draft) return;
    setBusy(true); setError(null);
    api.testIntegration(draft, key).then(s => { scrape.set(s); setTestKey(s.test?.key ?? null); })
      .catch(e => setError((e as Error).message)).finally(() => setBusy(false));
  };
  // the test's outcome, from the shared scrape state
  const t = testKey && scrape.state?.test?.key === testKey ? scrape.state : null;
  const testing = !!t && (t.status === 'running' || t.status === 'pipeline');
  useEffect(() => { if (t?.test?.saved) qc.invalidateQueries({ queryKey: ['integration-config'] }); }, [t?.test?.saved, qc]);

  const setField = (name: string, value: string) => draft && setDraft({ ...draft, fields: { ...draft.fields, [name]: value } });
  const catalog = data?.catalog;

  return (
    <SidePanel onClose={onClose} kicker={mode.kind === 'add' ? 'Add integration' : 'Edit integration'}
      title={entry?.label ?? (catalog && draft ? titleOf(catalog, draft) : 'Choose a source')}
      footer={draft && <>
          <div className="flex items-center gap-3">
            {entry && <button type="button" onClick={() => setRemoving(true)} className="min-h-9 font-medium text-muted hover:text-down">Remove</button>}
            {entry && (
              <button type="button" disabled={busy} onClick={() => run(api.disableIntegration(entry.key, !entry.disabled), false)} className="min-h-9 font-medium text-muted hover:text-ink">
                {entry.disabled ? 'Enable' : 'Disable'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {error && <Tip content={error}><span tabIndex={0} className="max-w-60 truncate text-down">{error}</span></Tip>}
            <button type="button" disabled={busy || testing || scrape.running} onClick={test} className={button}>{testing ? 'Testing…' : 'Test connection'}</button>
            <button type="submit" form="integration" disabled={busy || testing} className={primaryButton}>Save</button>
          </div>
      </>}>
      <div className="space-y-5">
        {catalog && !draft && mode.kind === 'add' && <Picker catalog={catalog} onPick={setDraft} />}
        {catalog && draft && (
          <form id="integration" className="space-y-4" autoComplete="off" onSubmit={e => { e.preventDefault(); save(); }}>
            {draft.type === 'exchange' && (
              <div>
                <label className={label} htmlFor="exchange">Exchange</label>
                <input id="exchange" list="exchanges" value={draft.exchange ?? ''} disabled={mode.kind === 'edit'} placeholder="binance"
                  onChange={e => setDraft({ ...draft, exchange: e.target.value })} className={`${input} disabled:bg-paper disabled:text-muted`} />
                <datalist id="exchanges">{catalog.exchange.suggestions.map(x => <option key={x} value={x} />)}</datalist>
              </div>
            )}
            {fieldsFor(catalog, draft).map(f => {
              const current = entry?.fields[f.name];
              return (
                <div key={f.name}>
                  <label className={label} htmlFor={`f-${f.name}`}>{f.label}{f.optional && <span className="font-normal text-faint"> · optional</span>}</label>
                  <input id={`f-${f.name}`} type={f.secret ? 'password' : 'text'} autoComplete="new-password" spellCheck={false}
                    value={draft.fields[f.name] ?? ''} onChange={e => setField(f.name, e.target.value)}
                    placeholder={current?.filled ? current.masked ?? '••••' : ''} className={input} />
                </div>
              );
            })}
            {draft.type === 'wallets' && (
              <>
                <div>
                  <span className={label}>Networks</span>
                  <div className="flex flex-wrap gap-1.5">
                    {[...new Set([...catalog.wallets.networks, ...(draft.networks ?? [])])].map(n => {
                      const on = draft.networks?.includes(n);
                      return (
                        <button key={n} type="button" onClick={() => setDraft({ ...draft, networks: on ? draft.networks!.filter(x => x !== n) : [...(draft.networks ?? []), n] })}
                          className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${on ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted hover:text-ink'}`}>
                          {n}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <span className={label}>Wallets</span>
                  <div className="space-y-2">
                    {(draft.wallets ?? []).map((w, i) => (
                      <div key={i} className="flex gap-2">
                        <input value={w.address} placeholder="0x…" spellCheck={false} className={`${input} min-w-0 flex-[3] font-mono text-xs`}
                          onChange={e => setDraft({ ...draft, wallets: draft.wallets!.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)) })} />
                        <input value={w.label ?? ''} placeholder="Label" className={`${input} min-w-0 flex-[2]`}
                          onChange={e => setDraft({ ...draft, wallets: draft.wallets!.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                        <button type="button" aria-label="Remove wallet" className="min-h-9 shrink-0 rounded-lg px-2 text-muted hover:text-down"
                          onClick={() => setDraft({ ...draft, wallets: draft.wallets!.filter((_, j) => j !== i) })}>×</button>
                      </div>
                    ))}
                    <button type="button" className={button} onClick={() => setDraft({ ...draft, wallets: [...(draft.wallets ?? []), { address: '', label: '' }] })}>Add wallet</button>
                  </div>
                </div>
              </>
            )}
          </form>
        )}
        {entry?.companyId === 'oneZero' && <OneZeroLink linked={!!entry.linked} />}
        {t && (
          <p className={`rounded-lg px-3 py-2 text-sm ${testing ? 'bg-ink/[0.04] text-muted' : t.test?.saved ? 'bg-up/10 text-up' : 'bg-down/5 text-down'}`}>
            {testing ? (t.otp ? 'Waiting for the code…' : 'Testing…') : t.test?.saved ? 'Connected · saved' : t.error ?? 'Failed · not saved'}
          </p>
        )}
        {removing && entry && (
          <div className="rounded-xl border border-down/30 bg-down/5 p-4 text-sm">
            <div className="font-medium text-ink">Remove {entry.label}?</div>
            <label className="mt-2 flex items-center gap-2 text-muted">
              <input type="checkbox" checked={keepData} onChange={e => setKeepData(e.target.checked)} className="accent-[var(--color-accent)]" />
              Keep its data
            </label>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busy} className="inline-flex items-center rounded-lg bg-down px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                onClick={() => run(api.removeIntegration(entry.key, keepData))}>Remove</button>
              <button type="button" className={button} onClick={() => setRemoving(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </SidePanel>
  );
}
