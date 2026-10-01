import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { ArrowUp, Database, LoaderCircle, Mic, Plus, Sparkles, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The data chat: a drawer that asks the user's own Claude Code (via POST /api/agent/chat, streamed)
 * questions about the household data. Text or push-to-talk (the browser's speech recognition, Hebrew).
 */

interface ChatMessage { role: 'user' | 'assistant'; text: string; tools: string[]; error?: string | null; pending?: boolean }
interface Saved { sessionId: string | null; messages: ChatMessage[] }

const STORAGE_KEY = 'agent-chat';
// one per skill in agent/.claude/skills, plus a quick question
const SUGGESTIONS = [
  'תן לי סיכום של החודש הקודם',
  'על אילו מנויים והוראות קבע אני משלם, ומה אפשר לבטל?',
  'כמה אני מוציא על סופרמרקט ולמה זה משתנה?',
  'כמה עלה הטיול האחרון?',
  'כמה נשאר לי להוציא עד סוף החודש?',
];
const SKILL_LABELS: Record<string, string> = {
  'monthly-review': 'סיכום חודש', 'subscriptions-audit': 'בדיקת מנויים', 'category-deep-dive': 'ניתוח קטגוריה', 'trip-cost': 'עלות טיול',
  'insurance-question': 'שאלה על פוליסה', 'insurance-review': 'סקירת ביטוחים',
  'pension-review': 'סקירת פנסיה', 'portfolio-review': 'סקירת תיק השקעות',
};

/** Open the chat from anywhere with a question — sent right away, or left in the box to finish. */
export function askAgent(text: string, send = false) {
  window.dispatchEvent(new CustomEvent('agent:ask', { detail: { text, send } }));
}

function load(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Saved | null;
    if (saved?.messages) return { sessionId: saved.sessionId, messages: saved.messages.map(m => ({ ...m, pending: false })) };
  } catch { /* storage unavailable */ }
  return { sessionId: null, messages: [] };
}
function save(s: Saved) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

/** What a tool call looked at, in words. */
function toolLabel(name: string, input: Record<string, unknown> | undefined): string {
  if (name === 'sql') return 'שאילתה על בסיס הנתונים';
  if (name === 'Read') return `קורא: ${String(input?.file_path ?? '').split('/').pop()?.replace(/^\d+-/, '') ?? 'מסמך'}`;
  if (name === 'Skill') return `מדריך: ${SKILL_LABELS[String(input?.skill ?? input?.command ?? '')] ?? String(input?.skill ?? '')}`;
  const path = String(input?.path ?? '').split('?')[0].replace(/^\/(api\/)?/, '');
  const labels: Record<string, string> = {
    summary: 'סקירה', 'month-plan': 'תכנית החודש', cashflow: 'תזרים לפי חודשים', budgets: 'תקציב', income: 'הכנסות',
    transactions: 'תנועות', installments: 'תשלומים', 'cards/upcoming': 'חיובי כרטיסים', forecast: 'תחזית', recurring: 'הוצאות קבועות',
    planned: 'הוצאות צפויות', networth: 'שווי נקי', recommendations: 'המלצות', alerts: 'התראות', categories: 'קטגוריות', meta: 'הגדרות',
    insurance: 'ביטוחים', pension: 'פנסיה וגמל', investments: 'תיק ההשקעות',
  };
  return labels[path] ?? path;
}

// ---- a small markdown renderer: paragraphs, lists, **bold**, tables, headings --------------------

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
      : part.startsWith('`') && part.endsWith('`') ? <code key={i} className="rounded bg-muted px-1 text-[0.85em]">{part.slice(1, -1)}</code>
      : <Fragment key={i}>{part}</Fragment>);
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
        i++;
      }
      blocks.push(
        <div key={i} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr>{rows[0]?.map((c, j) => <th key={j} className="border-b px-2 py-1 text-start font-semibold">{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j} className="border-b border-border/60 px-2 py-1">{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>);
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={i} className={cn('space-y-0.5 ps-5', ordered ? 'list-decimal' : 'list-disc')}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</List>);
      continue;
    }
    const heading = /^#{1,4}\s+(.*)/.exec(line);
    if (heading) { blocks.push(<div key={i} className="font-semibold">{inline(heading[1])}</div>); i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(\||[-*•]\s|\d+[.)]\s|#)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={i}>{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p)}</Fragment>)}</p>);
  }
  return <div className="space-y-2 leading-relaxed">{blocks}</div>;
}

// ---- speech -----------------------------------------------------------------------------------

type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
  start(): void; stop(): void;
};
const SpeechRecognition = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
  .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

// ---- the drawer ---------------------------------------------------------------------------------

export function AgentChat() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<Saved>(load);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const heard = useRef('');
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!busy) save(state); }, [state, busy]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [state.messages, open]);

  const patchLast = (f: (m: ChatMessage) => ChatMessage) =>
    setState(s => ({ ...s, messages: s.messages.map((m, i) => (i === s.messages.length - 1 ? f(m) : m)) }));

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    setState(s => ({ ...s, messages: [...s.messages, { role: 'user', text: message, tools: [] }, { role: 'assistant', text: '', tools: [], pending: true }] }));
    const controller = new AbortController();
    abort.current = controller;
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ message, sessionId: state.sessionId }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, cut).replace(/^data: /, '');
          buffer = buffer.slice(cut + 2);
          let ev: { type: string; text?: string; sessionId?: string; name?: string; input?: Record<string, unknown>; error?: string | null };
          try { ev = JSON.parse(chunk); } catch { continue; }
          if (ev.type === 'session' && ev.sessionId) setState(s => ({ ...s, sessionId: ev.sessionId! }));
          else if (ev.type === 'text') patchLast(m => ({ ...m, text: m.text + ev.text }));
          // a new text block after looking things up starts a new paragraph
          else if (ev.type === 'block') patchLast(m => (m.text && !m.text.endsWith('\n\n') ? { ...m, text: `${m.text}\n\n` } : m));
          else if (ev.type === 'tool') patchLast(m => ({ ...m, tools: [...m.tools, toolLabel(ev.name ?? '', ev.input)] }));
          else if (ev.type === 'done') {
            if (ev.sessionId) setState(s => ({ ...s, sessionId: ev.sessionId! }));
            patchLast(m => ({ ...m, pending: false, error: ev.error }));
          }
        }
      }
    } catch (err) {
      const stopped = (err as Error).name === 'AbortError';
      patchLast(m => ({ ...m, error: stopped ? null : (err as Error).message, text: stopped && !m.text ? 'נעצר.' : m.text }));
    } finally {
      patchLast(m => ({ ...m, pending: false }));
      abort.current = null;
      setBusy(false);
      textarea.current?.focus();
    }
  }

  // askAgent() from another page: open, then send or prefill
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onAsk = (e: Event) => {
      const { text, send: now } = (e as CustomEvent<{ text: string; send: boolean }>).detail;
      setOpen(true);
      if (now) sendRef.current(text);
      else {
        setInput(text);
        setTimeout(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(text.length, text.length); }, 80);
      }
    };
    window.addEventListener('agent:ask', onAsk);
    return () => window.removeEventListener('agent:ask', onAsk);
  }, []);

  function newChat() {
    abort.current?.abort();
    setState({ sessionId: null, messages: [] });
  }

  // push to talk: hold the mic, speak, release → the question is sent
  function startListening() {
    if (!SpeechRecognition || busy || listening) return;
    setMicError(null);
    heard.current = '';
    const rec = new SpeechRecognition();
    rec.lang = 'he-IL';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = e => {
      heard.current = Array.from(e.results).map(r => r[0].transcript).join(' ');
      setInput(heard.current);
    };
    rec.onerror = e => setMicError(e.error === 'not-allowed' ? 'אין הרשאה למיקרופון' : e.error === 'no-speech' ? 'לא נשמע דיבור' : `שגיאת זיהוי קול (${e.error})`);
    rec.onend = () => {
      setListening(false);
      recognition.current = null;
      if (heard.current.trim()) send(heard.current);
    };
    recognition.current = rec;
    rec.start();
    setListening(true);
  }
  const stopListening = () => recognition.current?.stop();

  const empty = state.messages.length === 0;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" aria-label="שאל את העוזר על הנתונים" title="שאל את העוזר על הנתונים" className="btn-ghost btn-icon relative text-fg-muted">
          <Sparkles className="h-[1.15rem] w-[1.15rem]" />
          {busy && <span className="absolute end-1 top-1 h-2 w-2 animate-pulse rounded-full bg-primary ring-2 ring-background" />}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[oklch(0.2_0.04_272/0.35)] backdrop-blur-[1px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content dir="rtl" aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex w-full flex-col border-e bg-background shadow-(--shadow-overlay) sm:w-[min(30rem,92vw)]
            pt-[env(safe-area-inset-top)] data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:duration-200 data-[state=open]:duration-300">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <span className="icon-tile h-8 w-8 rounded-lg [&_svg]:h-4 [&_svg]:w-4"><Sparkles /></span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold">שאל על הנתונים</Dialog.Title>
              <div className="text-xs text-muted-foreground">Claude · גישת קריאה בלבד לנתוני הבית</div>
            </div>
            {!empty && <button type="button" className="btn-ghost btn-icon" onClick={newChat} aria-label="שיחה חדשה" title="שיחה חדשה"><Plus /></button>}
            <Dialog.Close className="btn-ghost btn-icon" aria-label="סגור"><X /></Dialog.Close>
          </div>

          <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
            {empty && (
              <div className="space-y-3 pt-6 text-center">
                <Sparkles className="mx-auto h-8 w-8 text-primary/70" />
                <p className="text-muted-foreground">אפשר לשאול כל שאלה על ההכנסות, ההוצאות, התקציב והתחזית.<br />התשובות מבוססות על הנתונים שלך.</p>
                <div className="flex flex-col gap-2 pt-2">
                  {SUGGESTIONS.map(q => (
                    <button key={q} type="button" className="btn justify-start text-start text-sm" onClick={() => send(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}
            {state.messages.map((m, i) => m.role === 'user' ? (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-ss-sm bg-primary px-3.5 py-2 text-primary-foreground">{m.text}</div>
              </div>
            ) : (
              <div key={i} className="space-y-2">
                {m.tools.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {[...new Set(m.tools)].map(t => (
                      <span key={t} className="chip text-[11px] text-muted-foreground"><Database className="h-3 w-3" />{t}</span>
                    ))}
                  </div>
                )}
                {m.text && <Markdown text={m.text} />}
                {m.pending && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />{m.tools.length ? 'בודק בנתונים…' : 'חושב…'}
                  </div>
                )}
                {m.error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300" dir="auto">{m.error}</div>}
              </div>
            ))}
          </div>

          <form className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onSubmit={e => { e.preventDefault(); send(input); }}>
            {micError && <div className="mb-2 text-xs text-red-600">{micError}</div>}
            <div className={cn('flex items-end gap-2 rounded-2xl border bg-card p-1.5 transition-shadow focus-within:border-ring', listening && 'border-rose-400 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-rose-500)_20%,transparent)]')}>
              <textarea ref={textarea} rows={1} value={input} dir="auto" placeholder={listening ? 'מקשיב… שחרר כדי לשלוח' : 'שאלה על הנתונים…'}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); } }}
                className="max-h-36 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 outline-none [field-sizing:content]" />
              {SpeechRecognition && (
                <button type="button" aria-label="לחץ והחזק כדי לדבר" title="לחץ והחזק כדי לדבר" disabled={busy}
                  onPointerDown={e => { e.preventDefault(); startListening(); }} onPointerUp={stopListening} onPointerLeave={stopListening}
                  onKeyDown={e => { if (e.key === ' ' && !e.repeat) { e.preventDefault(); startListening(); } }}
                  onKeyUp={e => { if (e.key === ' ') stopListening(); }}
                  className={cn('btn-ghost btn-icon shrink-0 touch-none select-none', listening && 'animate-pulse bg-rose-500 text-white hover:bg-rose-500')}>
                  <Mic />
                </button>
              )}
              {busy ? (
                <button type="button" className="btn btn-icon shrink-0" aria-label="עצור" onClick={() => abort.current?.abort()}><Square /></button>
              ) : (
                <button type="submit" className="btn btn-primary btn-icon shrink-0" aria-label="שלח" disabled={!input.trim()}><ArrowUp /></button>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
