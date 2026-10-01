'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Kbd } from '@rezics/ui/kbd';
import { NativeSelect } from '@rezics/ui/native-select';
import { Switch } from '@rezics/ui/switch';
import { cn } from '@rezics/ui/utils';
import { InboxIcon, LockIcon, SirenIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { categoriesFor, textFor } from '../safety/report.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { agentLabel } from './format.ts';
import type { ManageMessages } from './messages.ts';
import { bffSafetyApi, type SafetyApi } from './safety-api.ts';
import { categoryName, ClaimChip, DeadlineChip, decisionKey, type CaseProblem, type PendingView, SafetyCasePanel,
  summaryOf } from './safety-case-panel.tsx';
import { SafetyDecisionDialog } from './safety-decision-dialog.tsx';
import { type Attempt, clearAttempt, loadAttempt, refusedForGood, saveAttempt, settleDecision } from './safety-pending.ts';
import { type Claim, claimOf, mergeCases, type Offer, offersFor, orderCases, SITE_SAFETY_PATH, stepsOf,
  type SafetyView } from './safety-state.ts';
import type { ReportEvidence, SafetyCase, SafetyItem, SafetyOutcome,
  SafetyPage } from './safety-types.ts';
import type { Loaded } from './types.ts';

const ADVANCED_KEY = 'rezics:manage:safety-advanced';
const dueWindows = [['dueOverdue', 'overdue'], ['dueDay', 'day'], ['dueWeek', 'week']] as const;
const languages = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;

const typing = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** A case read on its own, when it is not in the loaded pages: enough of an item for its panel. */
export function itemFromCase(view: SafetyCase): SafetyItem {
  return { caseId: view.caseId, kind: view.kind, urgent: view.urgent, generation: view.generation,
    decisionHead: view.decision?.decisionId ?? null, restricted: false, target: null,
    openedAt: view.steps.find(step => step.kind === 'intake')?.occurredAt ?? '',
    category: view.reports[0]?.category ?? null, contentLanguage: null, claimedBy: null,
    dueAt: view.steps.map(step => step.dueAt).filter((due): due is string => due !== null).sort()[0] ?? null };
}

/** The filters as a GET form: the address holds the view, so a second tab or a reload shows the same queue. */
function Filters({ view, locale, messages }: { view: SafetyView; locale: UiLocale; messages: ManageMessages }) {
  const t = materializeData(messages, { locale });
  const text = textFor(locale);
  return <form method="get" action={localizedPath(SITE_SAFETY_PATH, locale)} aria-label={t.safetyFilters}
    className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
    <Field><FieldLabel>{t.urgencyLabel}</FieldLabel>
      <NativeSelect name="urgency" defaultValue={view.urgent === null ? '' : view.urgent ? 'urgent' : 'routine'}>
        <option value="">{t.urgencyAny}</option><option value="urgent">{t.urgencyUrgent}</option>
        <option value="routine">{t.urgencyRoutine}</option></NativeSelect></Field>
    <Field><FieldLabel>{t.categoryFilter}</FieldLabel>
      <NativeSelect name="category" defaultValue={view.category ?? ''}>
        <option value="">{t.anyCategory}</option>
        {categoriesFor(null).map(category => <option key={category} value={category}>
          {categoryName(category, text)}</option>)}</NativeSelect></Field>
    <Field><FieldLabel>{t.languageFilter}</FieldLabel>
      <NativeSelect name="language" defaultValue={view.language ?? ''}>
        <option value="">{t.anyLanguage}</option>
        {languages.map(code => <option key={code} value={code}>
          {new Intl.DisplayNames([locale], { type: 'language' }).of(code)}</option>)}</NativeSelect></Field>
    <Field><FieldLabel>{t.dueFilter}</FieldLabel>
      <NativeSelect name="due" defaultValue={view.due ?? ''}>
        <option value="">{t.dueAny}</option>
        {dueWindows.map(([label, value]) => <option key={value} value={value}>{t[label]}</option>)}</NativeSelect></Field>
    <div className="flex gap-2">
      <Button type="submit" size="sm">{t.applyFilters}</Button>
      {view.urgent !== null || view.category || view.language || view.due
        ? <a href={localizedPath(SITE_SAFETY_PATH, locale)} className="inline-flex h-8 items-center rounded-lg px-3 text-sm
          hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">{t.clearFilters}</a> : null}
    </div>
  </form>;
}

/**
 * Platform staff's safety queue: Main's cases with urgent and overdue first,
 * the case beside it, and the decision dialog. Simple mode shows one case at a
 * time; keyboard triage (Advanced) adds the two-pane list and shortcuts. Every
 * read and write is one of Main's `/v1/safety-cases` calls through `api`.
 */
export function SafetyQueue({ actingSubject, initial, view, now, locale, messages, api, openCase, advanced: startAdvanced = false,
  names = {}, clock: readClock = Date.now }: {
  actingSubject: string; initial: SafetyPage; view: SafetyView; now: number; locale: UiLocale; messages: ManageMessages;
  api?: SafetyApi; openCase?: string | null; advanced?: boolean;
  /** The time source; the server's `now` is shown until the browser takes over. Stories fix it. */
  clock?: () => number;
  /** Public names of the Agents that hold claims, keyed by their ID. */
  names?: Record<string, string>;
}) {
  const t = materializeData(messages, { locale });
  const text = textFor(locale);
  const safety = useMemo(() => api ?? bffSafetyApi(actingSubject), [api, actingSubject]);
  const [items, setItems] = useState<SafetyItem[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [current, setCurrent] = useState<string | null>(openCase ?? null);
  const [details, setDetails] = useState<Record<string, Loaded<SafetyCase>>>({});
  const [evidence, setEvidence] = useState<Record<string, Loaded<ReportEvidence> | null>>({});
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({});
  const [resumes, setResumes] = useState<Record<string, PendingView>>({});
  const [advanced, setAdvanced] = useState(startAdvanced);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, CaseProblem>>({});
  /** The case, read, evidence and offer as they were when the dialog opened; a re-read cannot change the request under it. */
  const [dialog, setDialog] = useState<{ open: boolean; outcome: SafetyOutcome; item: SafetyItem; detail: SafetyCase;
    evidence: ReportEvidence | null; offer: Offer } | null>(null);
  const [paging, setPaging] = useState<'idle' | 'loading' | 'failed'>('idle');
  const rows = useRef(new Map<string, HTMLElement>());
  const claimKeys = useRef(new Map<string, string>());
  const [clock, setClock] = useState(now);
  useEffect(() => { setClock(readClock()); const timer = setInterval(() => setClock(readClock()), 30_000); return () => clearInterval(timer); }, [readClock]);
  useEffect(() => { try { setAdvanced(globalThis.localStorage?.getItem(ADVANCED_KEY) === '1' || startAdvanced); } catch { /* private mode */ } }, [startAdvanced]);

  const ordered = useMemo(() => orderCases(items, clock), [items, clock]);
  const item = useMemo(() => {
    const listed = ordered.find(entry => entry.caseId === current);
    if (listed) return listed;
    const read = current ? details[current] : undefined;
    return current && read?.ok ? itemFromCase(read.data) : null;
  }, [ordered, current, details]);
  const label = useCallback((agent: string | null) => agent ? names[agent] ?? agentLabel(undefined, agent,
    short => t.agentFallback({ id: short })) : null, [names, t]);

  const load = useCallback(async (caseId: string) => {
    const read = await safety.detail(caseId);
    setDetails(known => ({ ...known, [caseId]: read }));
    if (!read.ok) return;
    const report = read.data.reports[0];
    const found = report ? await safety.evidence(report.reportId) : null;
    setEvidence(known => ({ ...known, [caseId]: found }));
  }, [safety]);

  useEffect(() => { if (current && !details[current]) void load(current); }, [current, details, load]);
  // A request kept from an earlier visit (same device) comes back when its case is opened.
  useEffect(() => {
    if (!current || attempts[current]) return;
    const kept = loadAttempt(current);
    if (kept) setAttempts(known => ({ ...known, [current]: kept }));
  }, [current, attempts]);
  // Rows keep real focus with the current case, so screen readers follow keyboard triage.
  const focusRow = useRef(false);
  useEffect(() => { if (focusRow.current && current) { focusRow.current = false; rows.current.get(current)?.focus(); } }, [current]);

  const refresh = useCallback(async () => {
    const read = await safety.page(view, null, readClock());
    if (read.ok) { setItems(read.data.items); setCursor(read.data.nextCursor); }
    if (current) await load(current);
  }, [safety, view, current, load, readClock]);

  async function more() {
    if (!cursor) return;
    setPaging('loading');
    const read = await safety.page(view, cursor, readClock());
    if (!read.ok) { setPaging('failed'); return; }
    setItems(known => mergeCases(known, read.data.items));
    setCursor(read.data.nextCursor);
    setPaging('idle');
  }

  const claim = useCallback(async (target: SafetyItem) => {
    if (claiming) return;
    // One key per claim intent: a lost response and a second press claim once.
    const key = claimKeys.current.get(target.caseId) ?? crypto.randomUUID();
    claimKeys.current.set(target.caseId, key);
    setClaiming(target.caseId);
    setProblems(known => ({ ...known, [target.caseId]: null }));
    const outcome = await safety.claim(target.caseId, key);
    setClaiming(null);
    if (outcome.ok) {
      claimKeys.current.delete(target.caseId);
      setItems(known => known.some(entry => entry.caseId === target.caseId)
        ? known.map(entry => entry.caseId === target.caseId ? { ...entry, claimedBy: outcome.data.claimedBy } : entry)
        : [...known, { ...target, claimedBy: outcome.data.claimedBy }]);
      return;
    }
    claimKeys.current.delete(target.caseId);
    const failure: CaseProblem = outcome.failure === 'stale' || outcome.failure === 'conflict' ? 'claim-taken'
      : outcome.failure === 'denied' || outcome.failure === 'missing' ? 'claim-denied' : 'claim-failed';
    setProblems(known => ({ ...known, [target.caseId]: failure }));
    if (failure === 'claim-taken') void refresh();
  }, [claiming, safety, refresh]);

  const read = item ? details[item.caseId] : undefined;
  const offers = useMemo(() => item && read?.ok ? offersFor({ item, steps: stepsOf(read.data), now: clock,
    decision: read.data.decision ? { outcome: read.data.decision.outcome, operationStatus: read.data.decision.operation.status }
      : null }) : [], [item, read, clock]);
  const attempt = item ? attempts[item.caseId] ?? null : null;

  const keep = useCallback((caseId: string, next: Attempt | null) => {
    if (next) saveAttempt(next); else clearAttempt(caseId);
    setAttempts(known => { const { [caseId]: _old, ...rest } = known; return next ? { ...rest, [caseId]: next } : rest; });
  }, []);

  const decide = useCallback((outcome: SafetyOutcome) => {
    const offer = offers.find(entry => entry.outcome === outcome);
    const evidenceRead = item ? evidence[item.caseId] : null;
    if (!item || !read?.ok || !offer || offer.blocked || attempt || claimOf(item, actingSubject) !== 'mine') return;
    setDialog({ open: true, outcome, item, detail: read.data, offer, evidence: evidenceRead?.ok ? evidenceRead.data : null });
  }, [offers, item, read, evidence, attempt, actingSubject]);

  const resume = useCallback(async (target: Attempt) => {
    const caseId = target.caseId;
    setResumes(known => ({ ...known, [caseId]: { resuming: true, problem: null } }));
    const settled = await settleDecision(safety.decide, target.input);
    if (settled.kind === 'completed') {
      keep(caseId, null);
      setResumes(known => { const { [caseId]: _done, ...rest } = known; return rest; });
      void refresh();
      return;
    }
    if (settled.kind === 'failed' && !settled.recorded && refusedForGood(settled.failure)) keep(caseId, null);
    setResumes(known => ({ ...known, [caseId]: { resuming: false, problem: settled.kind === 'pending' ? 'still' : 'failed' } }));
    void load(caseId);
  }, [safety, keep, refresh, load]);

  useEffect(() => {
    if (!advanced) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (dialog || typing(event.target)) return;
      if (event.target instanceof HTMLElement && event.target.closest('[role=dialog]')) return;
      const at = ordered.findIndex(entry => entry.caseId === current);
      if (event.key === 'j' || event.key === 'k') {
        const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + (event.key === 'j' ? 1 : -1)))];
        if (!next) return;
        focusRow.current = true; setCurrent(next.caseId);
      } else if (event.key === 'c' && item && !item.restricted && claimOf(item, actingSubject) === 'free') void claim(item);
      else {
        const offer = offers.find(candidate => !candidate.blocked && decisionKey(candidate.outcome) === event.key);
        if (!offer) return;
        decide(offer.outcome);
      }
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [advanced, ordered, current, item, dialog, actingSubject, claim, decide, offers]);

  const waiting = cursor ? t.safetyWaitingAtLeast({ count: String(ordered.length) }) : t.safetyWaiting(ordered.length);
  const filtered = view.urgent !== null || view.category !== null || view.language !== null || view.due !== null;
  const panel = item ? <SafetyCasePanel item={item} detail={read} evidence={item ? evidence[item.caseId] : undefined}
    claim={claimOf(item, actingSubject)} claimedLabel={label(item.claimedBy)} claiming={claiming === item.caseId}
    problem={problems[item.caseId] ?? null} now={clock} locale={locale} messages={messages} advanced={advanced}
    offers={offers} pending={attempt ? resumes[item.caseId] ?? { resuming: false, problem: null } : null}
    onClaim={() => void claim(item)} onDecide={decide} onResume={() => { if (attempt) void resume(attempt); }} onRefresh={() => void refresh()}
    className={advanced ? 'lg:sticky lg:top-4' : undefined} /> : null;
  const single = !advanced && item !== null;
  // A case opened from its address that Main will not show: staff without the specialist role see that it is restricted.
  const orphan = current !== null && item === null ? details[current] : undefined;
  const orphanNote = current !== null && item === null && orphan !== undefined && !orphan.ok
    ? <Alert role={orphan.failure === 'denied' ? 'note' : 'alert'} variant={orphan.failure === 'denied' ? 'default' : 'destructive'}>
      {orphan.failure === 'denied' ? <LockIcon aria-hidden="true" /> : null}
      <AlertDescription>{orphan.failure === 'denied'
        ? <><strong className="block">{t.restrictedTitle}</strong>{t.restrictedHelp}</>
        : t.unavailableHelp}</AlertDescription></Alert> : null;

  function row(entry: SafetyItem) {
    const here = entry.caseId === current;
    const claimState: Claim = claimOf(entry, actingSubject);
    return <li key={entry.caseId}>
      <button type="button" ref={node => { if (node) rows.current.set(entry.caseId, node); else rows.current.delete(entry.caseId); }}
        aria-current={here ? 'true' : undefined} aria-label={t.openCase({ summary: summaryOf(entry, t, text) })}
        onClick={() => setCurrent(entry.caseId)} onFocus={() => { if (advanced) setCurrent(entry.caseId); }}
        className={cn('grid w-full gap-1.5 rounded-xl border px-3 py-3 text-start outline-none transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring', here ? 'border-primary/40 bg-primary/5'
            : 'border-border/60 hover:bg-accent/50', entry.urgent && 'border-s-4 border-s-destructive')}>
        <span className="flex min-w-0 flex-wrap items-center gap-2 font-medium">
          {entry.urgent ? <SirenIcon aria-hidden="true" className="size-4 shrink-0 text-destructive-foreground" /> : null}
          <span className="min-w-0 truncate">{categoryName(entry.category, text)
            ?? (entry.kind === 'rights_complaint' ? t.kindRightsComplaint : t.kindContentReport)}</span>
          {entry.urgent ? <span className="font-medium text-destructive-foreground text-xs">{t.caseUrgent}</span> : null}
          {entry.restricted ? <span className="inline-flex items-center gap-1 font-medium text-xs">
            <LockIcon aria-hidden="true" className="size-3.5" />{t.restrictedTitle}</span> : null}
        </span>
        <span className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <DeadlineChip dueAt={entry.dueAt} now={clock} locale={locale} messages={messages} />
          {entry.decisionHead ? <span>{t.caseRevisit}</span> : null}
          <ClaimChip claim={claimState} agent={label(entry.claimedBy)} locale={locale} messages={messages} />
        </span>
      </button>
    </li>;
  }

  const list = ordered.length ? <ul aria-label={t.safetyQueueLabel} className="grid content-start gap-2">
    {ordered.map(row)}</ul> : <EmptyState icon={InboxIcon} headingLevel={3}
    title={filtered ? t.safetyFilteredTitle : t.safetyEmptyTitle}
    description={filtered ? t.safetyFilteredHelp : t.safetyEmptyHelp}>
    {filtered ? <a href={localizedPath(SITE_SAFETY_PATH, locale)} className="font-medium text-primary text-sm underline">
      {t.clearFilters}</a> : null}</EmptyState>;

  return <div className="grid gap-5">
    <h2 className="sr-only">{t.safetyQueueLabel}</h2>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="text-muted-foreground text-sm">{waiting}</p>
      <div className="flex items-center gap-2 text-sm">
        <Switch aria-label={t.advancedLabel} checked={advanced} onCheckedChange={details => {
          setAdvanced(details.checked);
          try { globalThis.localStorage?.setItem(ADVANCED_KEY, details.checked ? '1' : '0'); } catch { /* private mode */ }
        }} />
        <span aria-hidden="true">{t.advancedLabel}</span>
      </div>
    </div>
    {advanced ? <p className="text-muted-foreground text-xs"><Kbd aria-hidden="true">J</Kbd> <Kbd aria-hidden="true">K</Kbd>{' '}
      {t.advancedHelp}</p> : null}
    <Filters view={view} locale={locale} messages={messages} />
    {orphanNote}
    {single ? <div className="grid gap-3">
      <div><Button type="button" variant="ghost" size="sm" onClick={() => setCurrent(null)}>← {t.closeCase}</Button></div>
      {panel}
    </div> : <div className={cn('grid gap-5', advanced && 'lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]')}>
      <div className="grid content-start gap-3">
        {list}
        {cursor ? <div><Button type="button" variant="outline" size="sm" onClick={() => void more()}
          isLoading={paging === 'loading'} disabled={paging === 'loading'}>{paging === 'failed' ? t.retry : t.loadMore}</Button></div>
          : null}
      </div>
      {advanced ? panel ?? null : null}
    </div>}
    {dialog ? <SafetyDecisionDialog item={dialog.item} detail={dialog.detail} outcome={dialog.open ? dialog.outcome : null}
      evidence={dialog.evidence} offer={dialog.offer} api={safety} actingSubject={actingSubject} locale={locale}
      messages={messages} onAttempt={next => keep(dialog.item.caseId, next)}
      onClose={() => { setDialog(known => known && { ...known, open: false }); void load(dialog.item.caseId); }}
      finalFocus={() => rows.current.get(dialog.item.caseId) ?? null}
      onDone={() => {
        setDialog(known => known && { ...known, open: false });
        void refresh();
      }} /> : null}
  </div>;
}
