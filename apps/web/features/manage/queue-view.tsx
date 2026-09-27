'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader } from '@rezics/ui/dialog';
import { Kbd } from '@rezics/ui/kbd';
import { cn } from '@rezics/ui/utils';
import { CheckCheckIcon, InboxIcon, KeyboardIcon, SirenIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { EmptyState } from '../shell/empty-state.tsx';
import type { Outcome } from './commands.ts';
import { agentLabel, isoTime, relativeTime } from './format.ts';
import { actionLabel, decidedText, kindLabel, reasonText, shortcutActions, shortcutKeys, stateLabel } from './labels.ts';
import type { ManageMessages } from './messages.ts';
import { Pill, Thumb } from './parts.tsx';
import { bffQueueApi, type QueueApi, reporters } from './queue-api.ts';
import { actionOrder, QueueDetail, type RulesState } from './queue-detail.tsx';
import { actionsFor, commonActions, type Decision, fullAuthority, initialTriage, itemsFor, needsReason, type PendingDecision,
  type QueueAction, type QueueAuthority, type Settled, targetIds, triage, UNDO_WINDOW_MS, visibleIds } from './queue-state.ts';
import { ReasonDialog } from './reason-dialog.tsx';
import { mergeAgents } from './read.ts';
import { type QueueView as View, queueHref } from './routes.ts';
import type { AgentSummary, DecisionBasis, Loaded, ModerationItem, ModerationKind, ModerationPage,
  WorkSummary } from './types.ts';

export interface QueueViewProps {
  realm: string;
  /** How the address names the Realm: its official Zone's segment, or its ID. Links keep it. */
  address?: string;
  actingSubject: string;
  /** What the acting Agent may decide here; everything when Main could not say. */
  authority?: QueueAuthority;
  /** Settings & rules, for someone who may publish the Realm's rules. */
  rulesHref?: string | null;
  view: View;
  initial: ModerationPage;
  agents: Record<string, AgentSummary>;
  works: Record<string, WorkSummary>;
  /** The render time, so relative times match between server and browser. */
  now: number;
  locale: UiLocale;
  messages: ManageMessages;
  /** Main through the BFF by default; stories pass a stand-in. */
  api?: QueueApi;
  /** How long a decision can be undone before it is sent. */
  undoWindowMs?: number;
}

const filters: ReadonlyArray<[ModerationKind | null, 'filterAll' | 'filterReports' | 'filterRights'
  | 'filterContributions' | 'filterCorrections']> = [[null, 'filterAll'], ['content_report', 'filterReports'],
  ['contribution_submission', 'filterContributions'], ['correction_submission', 'filterCorrections'],
  ['rights_complaint', 'filterRights']];

function outcomeOf(result: Outcome<unknown>): Settled {
  if (result.ok || result.failure === 'pending') return { kind: 'done' };
  if (result.code === 'rules_unpublished') return { kind: 'failed', failure: 'no-rules' };
  if (result.failure === 'stale') return { kind: 'stale' };
  if (result.failure === 'denied' || result.failure === 'sign-in' || result.failure === 'budget') {
    return { kind: 'failed', failure: result.failure };
  }
  return { kind: 'failed', failure: result.failure === 'invalid' ? 'invalid' : 'unavailable' };
}

const typing = (target: EventTarget | null) => target instanceof HTMLElement && target.closest(
  'input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;

/** What the reports read so far say about the Realm's rules: one published rule basis serves every report. */
function rulesOf(bases: Record<string, Loaded<DecisionBasis> | 'loading'>): RulesState {
  const read = Object.values(bases).flatMap(basis => basis !== 'loading' && basis.ok ? [basis.data] : []);
  if (read.some(basis => basis.ruleBasis)) return 'published';
  return read.length ? 'missing' : 'unknown';
}

/**
 * The Realm's triage list: one list across reports, rights complaints and
 * submissions, the current item in context beside it, keyboard triage, bulk
 * decisions and an undo window before anything reaches Main.
 */
export function QueueView({ realm, address = realm, actingSubject, authority = fullAuthority, rulesHref = null, view,
  initial, agents: initialAgents, works: initialWorks, now, locale, messages, api: givenApi,
  undoWindowMs = UNDO_WINDOW_MS }: QueueViewProps) {
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const api = useMemo(() => givenApi ?? bffQueueApi(realm, actingSubject, locale),
    [givenApi, realm, actingSubject, locale]);
  const [state, dispatch] = useReducer(triage, itemsFor(initial.items, view.state), initialTriage);
  const [names, setNames] = useState({ agents: initialAgents, works: initialWorks });
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [paging, setPaging] = useState<'idle' | 'loading' | 'moved' | 'failed'>('idle');
  const [dialog, setDialog] = useState<{ action: Exclude<QueueAction, 'approve' | 'keep'>; ids: string[] } | null>(null);
  const [help, setHelp] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Loaded<{ text: string; language: string }> | 'loading'>>({});
  const [bases, setBases] = useState<Record<string, Loaded<DecisionBasis> | 'loading'>>({});
  const rules = rulesOf(bases);
  // Without published rules there is nothing for a keep or remove decision to cite, so neither is offered.
  const effective = useMemo(() => ({ ...authority, decideReports: authority.decideReports && rules !== 'missing' }),
    [authority, rules]);
  const authorityRef = useRef(effective);
  authorityRef.current = effective;
  const [expanded, setExpanded] = useState(false);
  const [clock, setClock] = useState(now);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const focusCurrent = useRef(false);
  const committed = useRef(new Set<string>());
  const latest = useRef(state);
  latest.current = state;

  const visible = visibleIds(state);
  const current = state.current ? state.items[state.current] ?? null : null;
  const titleOf = useCallback((id: string) => {
    const item = latest.current.items[id];
    return item && names.works[item.target.resource]?.title.value || t.workFallback;
  }, [names.works, t.workFallback]);

  const learn = useCallback(async (items: readonly ModerationItem[]) => {
    const found = await api.names(items);
    setNames(known => ({ agents: mergeAgents(known.agents, found.agents), works: { ...known.works, ...found.works } }));
  }, [api]);

  const reload = useCallback(async () => {
    const read = await api.page(view, null);
    if (!read.ok) return;
    dispatch({ type: 'load', items: itemsFor(read.data.items, view.state) });
    setCursor(read.data.nextCursor);
    setPaging('idle');
    await learn(read.data.items);
  }, [api, view, learn]);

  const commit = useCallback(async (entry: PendingDecision) => {
    if (committed.current.has(entry.key)) return;
    committed.current.add(entry.key);
    dispatch({ type: 'commit', key: entry.key });
    const results = await Promise.all(entry.ids.map(async id => {
      const item = latest.current.items[id]!;
      const result = await api.commit(item, entry.decision, `${entry.key}:${id}`);
      const outcome = outcomeOf(result);
      dispatch({ type: 'settle', id, outcome });
      if (!result.ok && result.failure === 'pending') setFlash(t.pendingNotice);
      return outcome;
    }));
    // An escalated item stays open for the owners, so it comes back with its escalation shown.
    if (entry.decision.action === 'escalate' || results.some(outcome => outcome.kind === 'stale')) await reload();
  }, [api, reload, t.pendingNotice]);

  // The undo window: a clock while decisions wait, and each is sent when its window closes.
  const pendingCount = state.pending.length;
  useEffect(() => {
    if (!pendingCount) return;
    const timer = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, [pendingCount]);
  useEffect(() => {
    for (const entry of state.pending) if (entry.deadline <= clock) void commit(entry);
  }, [clock, state.pending, commit]);
  // Leaving the page sends what is waiting rather than dropping it.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    const flush = (event?: BeforeUnloadEvent) => {
      if (!latest.current.pending.length) return;
      for (const entry of latest.current.pending) void commitRef.current(entry);
      event?.preventDefault();
    };
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); flush(); };
  }, []);

  // The current submission's text, read once.
  useEffect(() => {
    if (!current?.submission || drafts[current.id] !== undefined) return;
    const id = current.id;
    setDrafts(known => ({ ...known, [id]: 'loading' }));
    void api.draft(current).then(read => setDrafts(known => ({ ...known, [id]: read })));
  }, [current, drafts, api]);

  // The current report's reports and rules, read once, when this person could decide it.
  useEffect(() => {
    if (current?.kind !== 'content_report' || !authority.decideReports || bases[current.id] !== undefined) return;
    const item = current;
    setBases(known => ({ ...known, [item.id]: 'loading' }));
    void api.basis(item).then(async read => {
      setBases(known => ({ ...known, [item.id]: read }));
      if (!read.ok) return;
      const found = await api.people(reporters(read.data));
      setNames(known => ({ ...known, agents: mergeAgents(known.agents, found) }));
    });
  }, [current, bases, api, authority.decideReports]);

  // Keyboard moves real focus with the current item, so screen readers follow it.
  useEffect(() => {
    if (!focusCurrent.current || !state.current) return;
    focusCurrent.current = false;
    const row = rows.current.get(state.current);
    row?.focus();
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [state.current]);

  const decide = useCallback((ids: readonly string[], decision: Decision) => {
    focusCurrent.current = true;
    setFlash(null);
    dispatch({ type: 'decide', key: crypto.randomUUID(), ids, decision, now: Date.now(), window: undoWindowMs });
    setClock(Date.now());
  }, [undoWindowMs]);

  /** Decides the targets with the first of `wanted` they all allow, as a shortcut key stands for several actions. */
  const act = useCallback((wanted: QueueAction | readonly QueueAction[]) => {
    const snapshot = latest.current;
    const ids = targetIds(snapshot);
    if (!ids.length) { setFlash(t.noneSelected); return; }
    const choices = typeof wanted === 'string' ? [wanted] : wanted;
    const allowed = commonActions(snapshot, ids, authorityRef.current);
    const action = choices.find(choice => allowed.has(choice));
    if (!action) {
      // Name the choice that fits these items (Keep for a report, Approve for a submission), not the key's first.
      const fitting = [...commonActions(snapshot, ids)].find(choice => choices.includes(choice)) ?? choices[0]!;
      setFlash(t.notAvailable({ action: actionLabel(fitting, t) }));
      return;
    }
    if (needsReason(action)) setDialog({ action, ids });
    else decide(ids, { action, reason: null, note: null });
  }, [decide, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (dialog || help || typing(event.target)) return;
      if (event.target instanceof HTMLElement && event.target.closest('[role=dialog], [role=menu]')) return;
      const key = event.key;
      if (event.shiftKey && key !== '?') return;
      switch (key) {
        case 'j': focusCurrent.current = true; dispatch({ type: 'move', delta: 1 }); break;
        case 'k': focusCurrent.current = true; dispatch({ type: 'move', delta: -1 }); break;
        case 'x': if (latest.current.current) dispatch({ type: 'toggle', id: latest.current.current }); break;
        case 'a': case 'r': case 'c': case 'e': act(shortcutActions(key)); break;
        case 'z': case 'u': if (latest.current.pending.length) { focusCurrent.current = true; dispatch({ type: 'undo' }); }
          break;
        case '?': setHelp(true); break;
        case 'Escape': if (!latest.current.selected.length) return; dispatch({ type: 'clear-selection' }); break;
        default: return;
      }
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [act, dialog, help]);

  async function more() {
    if (!cursor) return;
    setPaging('loading');
    const read = await api.page(view, cursor);
    if (!read.ok) { setPaging(read.failure === 'moved' ? 'moved' : 'failed'); return; }
    dispatch({ type: 'load', items: itemsFor(read.data.items, view.state), append: true });
    setCursor(read.data.nextCursor);
    setPaging('idle');
    await learn(read.data.items);
  }

  const selected = new Set(state.selected);
  const bulk = state.selected.filter(id => visible.includes(id));
  const bulkActions = commonActions(state, bulk, effective);
  const notices = Object.entries(state.settled).filter(([, outcome]) => outcome.kind !== 'done');
  const last = state.pending.at(-1);
  const waiting = view.state === 'open';
  const summary = !waiting ? null : cursor ? t.waitingAtLeast({ count: String(visible.length) })
    : visible.length ? t.waiting(visible.length) : t.nothingWaiting;

  function row(id: string) {
    const item = state.items[id]!;
    const title = titleOf(id);
    const work = names.works[item.target.resource];
    const author = item.authorAgent ? agentLabel(names.agents[item.authorAgent], item.authorAgent,
      short => t.agentFallback({ id: short })) : null;
    const reason = reasonText(item, t);
    const isCurrent = state.current === id;
    const outcome = state.settled[id];
    return <li key={id} className={cn('group relative flex items-start gap-3 rounded-xl border px-3 py-3 transition-colors',
      isCurrent ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:bg-accent/50',
      selected.has(id) && !isCurrent && 'bg-accent/40')}>
      {waiting ? <input type="checkbox" checked={selected.has(id)} onChange={() => dispatch({ type: 'toggle', id })}
        aria-label={t.selectItem({ title })} className="mt-3 size-4 shrink-0 accent-primary" /> : null}
      <button type="button" ref={node => { if (node) rows.current.set(id, node); else rows.current.delete(id); }}
        onClick={() => { dispatch({ type: 'focus', id }); setExpanded(current => !isCurrent || !current); }}
        onFocus={() => dispatch({ type: 'focus', id })}
        aria-current={isCurrent ? 'true' : undefined} aria-expanded={isCurrent && expanded ? true : undefined}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-start outline-none focus-visible:ring-2
          focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        <Thumb image={work?.cover ?? null} label={title} fallbackKey={item.target.resource} shape="cover" />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium">{work ? <span lang={work.title.language}>{title}</span> : title}</span>
            {item.escalation ? <SirenIcon aria-label={t.escalatedBadge} className="size-3.5 shrink-0 text-warning-foreground" />
              : null}
          </span>
          <span className="truncate text-muted-foreground text-sm">
            {[kindLabel(item.kind, t), reason, author].filter(Boolean).join(' · ')}</span>
          <span className="text-muted-foreground text-xs">
            {waiting ? <time dateTime={isoTime(item.openedAt)}>{relativeTime(item.openedAt, now, locale)}</time>
              : stateLabel(item, t)}</span>
        </span>
      </button>
      {outcome && outcome.kind !== 'done' ? <span className="sr-only">{outcome.kind === 'stale' ? t.staleNotice : t.failedNotice}</span>
        : null}
    </li>;
  }

  const detail = (className?: string) => <QueueDetail item={current} agents={names.agents} works={names.works}
    draft={current ? drafts[current.id] : undefined} basis={current ? bases[current.id] : undefined}
    allowed={current && visible.includes(current.id) ? actionsFor(current, effective) : new Set()}
    authority={authority} rules={rules} rulesHref={rulesHref} onAct={act} now={now} locale={locale} messages={messages}
    className={className} />;

  return <div className="grid gap-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h2 className="font-semibold text-xl tracking-tight">{t.queueTitle}</h2>
        {summary ? <p className="text-muted-foreground text-sm" aria-live="polite">{summary}</p> : null}
      </div>
      <Button variant="ghost" size="sm" onClick={() => setHelp(true)} aria-keyshortcuts="?">
        <KeyboardIcon aria-hidden="true" />{t.shortcuts}<Kbd aria-hidden="true">?</Kbd></Button>
    </div>
    <div className="grid gap-3">
      <nav aria-label={t.stateLabel} className="flex gap-2">
        <Pill href={queueHref(address, { ...view, state: 'open' })} current={view.state === 'open'}>{t.stateOpen}</Pill>
        <Pill href={queueHref(address, { ...view, state: 'closed' })} current={view.state === 'closed'}>{t.stateClosed}</Pill>
      </nav>
      <nav aria-label={t.filterLabel} className="flex gap-2 overflow-x-auto pb-1">
        {filters.map(([type, label]) => <Pill key={label} href={queueHref(address, { ...view, type })}
          current={view.type === type}>{t[label]}</Pill>)}
      </nav>
    </div>
    <div role="status" aria-live="polite" className="empty:hidden">{flash ? <p className="text-sm">{flash}</p> : null}</div>
    {notices.length ? <div className="grid gap-2">
      {notices.map(([id, outcome]) => <Alert key={id} variant={outcome.kind === 'gone' ? 'info' : 'warning'}>
        <AlertDescription className="flex items-start justify-between gap-3">
          <span>{outcome.kind === 'gone' ? t.goneNotice({ title: titleOf(id) })
            : outcome.kind === 'stale' ? `${titleOf(id)}: ${t.staleNotice}`
              : `${titleOf(id)}: ${outcome.kind === 'failed' && outcome.failure === 'denied' ? t.deniedNotice
                : outcome.kind === 'failed' && outcome.failure === 'no-rules' ? t.noRulesNotice : t.failedNotice}`}</span>
          <Button size="icon-xs" variant="ghost" aria-label={t.dismiss} onClick={() => dispatch({ type: 'dismiss', id })}>
            <XIcon aria-hidden="true" /></Button>
        </AlertDescription>
      </Alert>)}
    </div> : null}
    {!visible.length && !state.pending.length && !state.committing.length && !cursor
      ? <EmptyState icon={waiting ? CheckCheckIcon : InboxIcon}
        title={waiting ? view.type ? t.emptyFilteredTitle : t.emptyOpenTitle : t.emptyClosedTitle}
        description={waiting ? view.type ? t.emptyFilteredHelp : t.emptyOpenHelp : t.emptyClosedHelp}>
        {view.type ? <LocalizedLink href={queueHref(address, { ...view, type: null })}
          className="font-medium text-primary text-sm hover:underline">{t.showAll}</LocalizedLink> : null}
      </EmptyState>
      : <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="grid content-start gap-2">
          {waiting ? <div aria-label={t.bulkLabel} role="group" className="sticky top-16 z-10 flex min-h-10 flex-wrap items-center
            gap-2 rounded-xl bg-background/90 px-3 py-1.5 backdrop-blur">
            <input type="checkbox" aria-label={t.selectAll} checked={bulk.length > 0 && bulk.length === visible.length}
              ref={node => { if (node) node.indeterminate = bulk.length > 0 && bulk.length < visible.length; }}
              onChange={() => dispatch({ type: bulk.length === visible.length ? 'clear-selection' : 'select-all' })}
              className="size-4 accent-primary" />
            {bulk.length ? <>
              <span className="font-medium text-sm">{t.selectedCount(bulk.length)}</span>
              {actionOrder.filter(action => bulkActions.has(action))
                .map(action => <Button key={action} size="xs"
                  variant={action === 'approve' || action === 'keep' ? 'default' : 'outline'}
                  onClick={() => act(action)}>{actionLabel(action, t)}</Button>)}
              {bulkActions.size ? null : <span className="text-muted-foreground text-sm">{t.noCommonAction}</span>}
              <Button size="xs" variant="ghost" onClick={() => dispatch({ type: 'clear-selection' })}>{t.clearSelection}</Button>
            </> : <span className="text-muted-foreground text-sm">{t.selectAll}</span>}
          </div> : null}
          <ul aria-label={t.queueLabel} className="grid gap-1">
            {visible.map(id => <Fragment key={id}>
              {row(id)}
              {state.current === id && expanded ? <li className="lg:hidden">{detail()}</li> : null}
            </Fragment>)}
          </ul>
          {cursor ? <div className="flex flex-col items-start gap-2 pt-2">
            {paging === 'moved' ? <p className="text-sm">{t.movedTitle}{' '}
              <Button variant="link" size="sm" onClick={() => void reload()}>{t.startOver}</Button></p>
              : <Button variant="outline" size="sm" isLoading={paging === 'loading'} onClick={() => void more()}>
                {paging === 'loading' ? t.loadingMore : paging === 'failed' ? t.retry : t.loadMore}</Button>}
          </div> : null}
        </div>
        <div className="hidden lg:block">
          <div className="sticky top-20">{detail()}</div>
        </div>
      </div>}
    {last ? <div role="status" aria-label={t.pendingLabel} className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))]
      z-40 mx-auto flex max-w-lg items-center gap-3 rounded-2xl border border-border/60 bg-popover px-4 py-3 text-popover-foreground
      shadow-(--aura-shadow-card) md:bottom-5">
      <p className="min-w-0 flex-1 text-sm">
        <span className="block truncate font-medium">{decidedText(last.decision.action, last.ids.map(titleOf), t)}</span>
        <span className="text-muted-foreground text-xs">
          {t.sendingIn({ seconds: String(Math.max(0, Math.ceil((last.deadline - clock) / 1000))) })}
          {state.pending.length > 1 ? ` · +${state.pending.length - 1}` : ''}</span>
      </p>
      <Button size="sm" variant="outline" aria-keyshortcuts="z" onClick={() => {
        focusCurrent.current = true;
        dispatch({ type: 'undo', key: last.key });
      }}>{t.undo}<Kbd aria-hidden="true">Z</Kbd></Button>
    </div> : state.committing.length ? <div role="status" className="sr-only">{t.sending}</div> : null}
    <ReasonDialog action={dialog?.action ?? null} count={dialog?.ids.length ?? 1} locale={locale} messages={messages}
      finalFocus={() => (latest.current.current ? rows.current.get(latest.current.current) : null) ?? null}
      onClose={() => setDialog(null)}
      onDecide={decision => { const ids = dialog?.ids ?? []; setDialog(null); decide(ids, decision); }} />
    <Dialog open={help} onOpenChange={details => setHelp(details.open)}>
      <DialogContent size="sm">
        <DialogHeader title={t.shortcuts} description={t.shortcutsHelp} />
        <DialogBody>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-sm">
            {([['J', t.shortcutNext], ['K', t.shortcutPrevious], ['X', t.shortcutSelect],
              [shortcutKeys.approve.toUpperCase(), t.shortcutApprove], [shortcutKeys.reject.toUpperCase(), t.shortcutReject],
              [shortcutKeys['request-changes'].toUpperCase(), t.shortcutChanges],
              [shortcutKeys.escalate.toUpperCase(), t.shortcutEscalate], ['Z', t.shortcutUndo],
              ['Esc', t.shortcutClear], ['?', t.shortcutHelp]] as const).map(([key, label]) =>
              <div key={key} className="contents"><dt><Kbd>{key}</Kbd></dt><dd>{label}</dd></div>)}
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  </div>;
}
