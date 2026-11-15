import { KnowledgeDetails, knowledgeControl } from './workspace';
import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { DocumentSnapshot } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@rezics/ui/shadcn/select';
import { m } from '../paraglide/messages.js';
import type { KnowledgePrivateAddress } from './private-knowledge';
import {
  type KnowledgeHistoryBinding,
  type KnowledgeHistoryComparison,
  type KnowledgeHistoryFailure,
  type KnowledgeHistoryOperations,
  type KnowledgeHistoryPage,
  type KnowledgeHistoryPair,
} from './history';
import { KnowledgeHistoryComparisonView } from './history-comparison';
import {
  createKnowledgeHistoryFocus,
  firstKnowledgeHistoryPage,
  nextKnowledgeHistoryPage,
  previousKnowledgeHistoryPage,
  retainKnowledgeHistoryNavigation,
  type KnowledgeHistoryNavigation,
} from './history-navigation';

const control = knowledgeControl;
type Admission = 'unknown' | 'available' | 'denied' | 'unavailable';

/** Editor-owned lifetime: no router navigation, query cache, persistence or automatic reads. */
export function KnowledgeHistoryPanel({
  address,
  binding,
  admission,
  compareAdmission,
  operations,
  conflictPair,
  draft,
  locale,
  isCurrent,
  onRetire,
}: {
  address: KnowledgePrivateAddress;
  binding: KnowledgeHistoryBinding;
  admission: Admission;
  compareAdmission: Admission;
  operations: KnowledgeHistoryOperations | undefined;
  conflictPair: KnowledgeHistoryPair | null;
  draft: DocumentSnapshot;
  locale: string;
  isCurrent: () => boolean;
  onRetire: (state: 'retired' | 'denied' | 'signed-out') => void;
}) {
  const options = { locale: locale as never };
  const id = useId();
  const live = useRef(false);
  const sequence = useRef(0);
  const busy = useRef(false);
  const historyTrigger = useRef<HTMLButtonElement>(null);
  const conflictTrigger = useRef<HTMLButtonElement>(null);
  const compareTrigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnTarget = useRef<HTMLElement | null>(null);
  const editorReturnTarget = useRef<HTMLElement | null>(null);
  const focusTarget = useRef<{ ticket: number; target: 'heading' | 'return' } | null>(null);
  const [focus] = useState(createKnowledgeHistoryFocus);
  const [focusTick, setFocusTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const [pending, setPending] = useState(false);
  const [page, setPage] = useState<KnowledgeHistoryPage | null>(null);
  const [pageState, setPageState] = useState('idle');
  const [navigation, setNavigation] = useState(firstKnowledgeHistoryPage);
  const [attempt, setAttempt] = useState<KnowledgeHistoryNavigation | null>(null);
  const [leftRevisionId, setLeft] = useState('');
  const [rightRevisionId, setRight] = useState('');
  const [pair, setPair] = useState<KnowledgeHistoryPair | null>(null);
  const [comparison, setComparison] = useState<KnowledgeHistoryComparison | null>(null);
  const [compareState, setCompareState] = useState('idle');

  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      sequence.current++;
      focus.cancel();
      focusTarget.current = null;
      returnTarget.current = null;
      editorReturnTarget.current = null;
    };
  }, [focus]);
  useLayoutEffect(() => {
    const requested = focusTarget.current;
    focusTarget.current = null;
    if (!requested) return;
    if (!current(requested.ticket)) return focus.cancel();
    focus.arrive(requested.target === 'heading' ? heading.current : returnTarget.current);
  }, [focusTick, focus]);

  function requestFocus(event: MouseEvent<HTMLElement>, ticket: number) {
    focusTarget.current = null;
    focus.request(event.currentTarget, event.detail === 0, () => current(ticket));
  }
  function arrive(ticket: number, target: 'heading' | 'return') {
    focusTarget.current = { ticket, target };
    setFocusTick((value) => value + 1);
  }
  function current(ticket: number) {
    return live.current && isCurrent() && sequence.current === ticket;
  }
  function invalidate() {
    sequence.current++;
    busy.current = false;
    setPending(false);
    focus.cancel();
    focusTarget.current = null;
  }
  function clearHistory() {
    setOpen(false);
    setShowComparison(false);
    setPage(null);
    setNavigation(firstKnowledgeHistoryPage());
    setAttempt(null);
    setLeft('');
    setRight('');
    setPair(null);
    setComparison(null);
    setPageState('idle');
    setCompareState('idle');
    returnTarget.current = null;
    editorReturnTarget.current = null;
  }
  function refused(result: KnowledgeHistoryFailure) {
    if (result.state === 'denied' || result.state === 'signed-out' || result.state === 'retired') {
      invalidate();
      clearHistory();
      onRetire(result.state);
    }
  }
  async function load(request: KnowledgeHistoryNavigation, event: MouseEvent<HTMLElement>) {
    if (!operations || busy.current || !live.current || !isCurrent() || admission !== 'available') return;
    const ticket = ++sequence.current;
    requestFocus(event, ticket);
    if (!open) editorReturnTarget.current = historyTrigger.current;
    busy.current = true;
    setPending(true);
    setOpen(true);
    setShowComparison(false);
    setPage(null);
    setComparison(null);
    setPair(null);
    setAttempt(request);
    setPageState('preparing');
    try {
      const result = await operations.read(address, request.cursor, binding);
      if (!current(ticket)) return;
      if (result.state === 'ready') {
        setPage(result.page);
        setNavigation(retainKnowledgeHistoryNavigation(request, result.page.next));
        setAttempt(null);
        setPageState('ready');
      } else {
        setPageState(result.state);
        refused(result);
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      if (current(ticket)) setPageState('unavailable');
    } finally {
      if (current(ticket)) {
        busy.current = false;
        setPending(false);
        arrive(ticket, 'heading');
      }
    }
  }
  async function compare(
    exactPair: KnowledgeHistoryPair,
    initiator: HTMLElement | null,
    event: MouseEvent<HTMLElement>,
  ) {
    if (!operations || busy.current || !live.current || !isCurrent() || compareAdmission !== 'available') return;
    const ticket = ++sequence.current;
    requestFocus(event, ticket);
    if (!open) editorReturnTarget.current = initiator;
    busy.current = true;
    setPending(true);
    setOpen(true);
    setShowComparison(true);
    setPair(exactPair);
    setComparison(null);
    setCompareState('preparing');
    returnTarget.current = initiator;
    try {
      const result = await operations.compare(address, exactPair, binding);
      if (!current(ticket)) return;
      if (result.state === 'ready') {
        setComparison(result.comparison);
        setCompareState('ready');
      } else {
        setCompareState(result.state);
        refused(result);
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      if (current(ticket)) setCompareState('unavailable');
    } finally {
      if (current(ticket)) {
        busy.current = false;
        setPending(false);
        arrive(ticket, 'heading');
      }
    }
  }
  function back(event: MouseEvent<HTMLElement>) {
    if (!live.current || !isCurrent()) return;
    invalidate();
    const ticket = sequence.current;
    requestFocus(event, ticket);
    setComparison(null);
    setPair(null);
    setCompareState('idle');
    setShowComparison(false);
    arrive(ticket, 'return');
  }
  function close(event: MouseEvent<HTMLElement>) {
    if (!live.current || !isCurrent()) return;
    const target = editorReturnTarget.current ?? historyTrigger.current;
    invalidate();
    clearHistory();
    const ticket = sequence.current;
    requestFocus(event, ticket);
    returnTarget.current = target;
    arrive(ticket, 'return');
  }
  const failureText = (state: string) => {
    if (state === 'preparing' || state === 'unknown') return m.knowledge_private_preparing({}, options);
    if (state === 'stale') return m.knowledge_history_stale({}, options);
    if (state === 'not-found') return m.knowledge_private_not_found({}, options);
    if (state === 'denied') return m.knowledge_private_denied({}, options);
    return m.knowledge_history_unavailable({}, options);
  };
  const state = showComparison ? compareState : pageState;
  const historyDateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'long',
    timeZone: 'UTC',
  });
  const formatHistoryDate = (createdAt: string) =>
    historyDateFormatter.format(new Date(createdAt));
  const leftSelectId = `${id}-history-left`;
  const rightSelectId = `${id}-history-right`;
  const historyIntroId = `${id}-history-intro`;
  const admissionStatusId = `${id}-admission`;
  const compareStatusId = `${id}-compare-status`;
  const compareHelpId = `${id}-compare-help`;
  const compareDescribedBy =
    compareAdmission !== 'available' && (open || conflictPair)
      ? compareStatusId
      : open && !showComparison
        ? compareHelpId
        : undefined;
  const leftSummaryId = showComparison && pair ? pair.leftRevisionId : leftRevisionId;
  const rightSummaryId = showComparison && pair ? pair.rightRevisionId : rightRevisionId;
  const leftSummaryRow = page?.revisions.find((row) => row.revisionId === leftSummaryId);
  const rightSummaryRow = page?.revisions.find((row) => row.revisionId === rightSummaryId);
  return (
    <section
      id="knowledge-revisions"
      className="min-w-0 scroll-mt-6 space-y-5 border-t border-border pt-6 [overflow-wrap:anywhere]"
      aria-label={m.knowledge_history_heading({}, options)}
    >
      <div className="flex min-w-0 flex-wrap gap-3">
        <Button
          ref={historyTrigger}
          type="button"
          variant="outline"
          className={control}
          disabled={pending || open || admission !== 'available' || !operations}
          aria-describedby={admission !== 'available' ? admissionStatusId : undefined}
          onClick={(event) => void load(firstKnowledgeHistoryPage(), event)}
        >
          {m.knowledge_history_open({}, options)}
        </Button>
        {conflictPair ? (
          <Button
            ref={conflictTrigger}
            type="button"
            variant="outline"
            className={control}
            disabled={pending || compareAdmission !== 'available' || !operations}
            aria-describedby={compareDescribedBy}
            onClick={(event) => void compare(conflictPair, conflictTrigger.current, event)}
          >
            {m.knowledge_history_compare_heads({}, options)}
          </Button>
        ) : null}
      </div>
      {admission !== 'available' ? (
        <p id={admissionStatusId} role="status">
          {failureText(admission)}
        </p>
      ) : null}
      {compareAdmission !== 'available' && (open || conflictPair) ? (
        <p id={compareStatusId} role="status">
          {failureText(compareAdmission)}
        </p>
      ) : null}
      {open ? (
        <div className="min-w-0 space-y-6" aria-busy={pending}>
          <h2
            ref={heading}
            tabIndex={-1}
            className="text-lg font-semibold leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {showComparison ? m.knowledge_history_comparison({}, options) : m.knowledge_history_heading({}, options)}
          </h2>
          <p id={historyIntroId} className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {m.knowledge_history_intro({}, options)}
          </p>
          <KnowledgeDetails label={m.knowledge_workspace_details({}, options)}>
            <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-sm font-medium">{m.knowledge_private_document_id({}, options)}</dt>
                <dd className="break-all text-sm">{address.documentId}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm font-medium">{m.knowledge_private_notebook_id({}, options)}</dt>
                <dd className="break-all text-sm">{address.notebookId}</dd>
              </div>
            </dl>
          </KnowledgeDetails>
          <div className="flex min-w-0 flex-wrap gap-3">
            {showComparison && pageState !== 'idle' ? (
              <Button type="button" variant="outline" className={control} onClick={back}>
                {m.knowledge_history_back({}, options)}
              </Button>
            ) : null}
            <Button type="button" variant="outline" className={control} onClick={close}>
              {m.knowledge_history_return({}, options)}
            </Button>
          </div>
          {!['idle', 'ready'].includes(state) ? (
            <p role={state === 'preparing' ? 'status' : 'alert'}>{failureText(state)}</p>
          ) : null}
          <section
            className="min-w-0 space-y-5 border-y border-border py-5"
            aria-label={m.knowledge_history_comparison({}, options)}
          >
            <div className="space-y-3">
              <h3 className="text-base font-semibold">{m.knowledge_history_comparison({}, options)}</h3>
              <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                {(['left', 'right'] as const).map((side) => {
                  const revisionId = side === 'left' ? leftSummaryId : rightSummaryId;
                  const row = side === 'left' ? leftSummaryRow : rightSummaryRow;
                  const revision = side === 'left' ? comparison?.left : comparison?.right;
                  return (
                    <div key={side} className="min-w-0 space-y-1">
                      <dt className="text-sm font-medium">
                        {side === 'left'
                          ? m.knowledge_history_left({}, options)
                          : m.knowledge_history_right({}, options)}
                      </dt>
                      <dd className="min-w-0 space-y-1 text-sm">
                        {revision?.title || row?.title ? (
                          <span className="block break-words font-medium [overflow-wrap:anywhere]">
                            {revision?.title ?? row?.title}
                          </span>
                        ) : null}
                        {row ? (
                          <time dateTime={row.createdAt} className="block text-muted-foreground">
                            {formatHistoryDate(row.createdAt)}
                          </time>
                        ) : null}
                        <span className="block break-all font-mono text-xs text-muted-foreground">
                          {revisionId || '—'}
                        </span>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
            {!showComparison ? (
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                {(['left', 'right'] as const).map((side) => {
                  const value = side === 'left' ? leftRevisionId : rightRevisionId;
                  const otherValue = side === 'left' ? rightRevisionId : leftRevisionId;
                  const selectId = side === 'left' ? leftSelectId : rightSelectId;
                  const selectedLabel =
                    side === 'left' ? m.knowledge_history_left({}, options) : m.knowledge_history_right({}, options);
                  const selectedIsOnPage = page?.revisions.some((row) => row.revisionId === value) ?? false;
                  return (
                    <Field key={side} className="min-w-0">
                      <FieldLabel htmlFor={selectId}>{selectedLabel}</FieldLabel>
                      <Select
                        value={value || null}
                        onValueChange={(nextValue) => {
                          if (!nextValue || !live.current || !isCurrent()) return;
                          focus.cancel();
                          if (side === 'left') setLeft(nextValue);
                          else setRight(nextValue);
                        }}
                      >
                        <SelectTrigger
                          id={selectId}
                          aria-describedby={historyIntroId}
                          className="h-auto min-h-11 w-full min-w-0 whitespace-normal py-2 text-start [overflow-wrap:anywhere] *:data-[slot=select-value]:line-clamp-none *:data-[slot=select-value]:whitespace-normal"
                          disabled={pending || !page}
                        >
                          <SelectValue placeholder={m.knowledge_private_revision({}, options)} />
                        </SelectTrigger>
                        <SelectContent align="start">
                          <SelectGroup>
                            {value && !selectedIsOnPage ? (
                              <>
                                <SelectLabel className="break-all whitespace-normal">
                                  {selectedLabel}: {value}
                                </SelectLabel>
                                <SelectItem
                                  value={value}
                                  disabled
                                  className="min-h-11 whitespace-normal [&>:first-child]:min-w-0 [&>:first-child]:max-w-full [&>:first-child]:shrink [&>:first-child]:whitespace-normal [&>:first-child]:[overflow-wrap:anywhere]"
                                >
                                  <span className="min-w-0 whitespace-normal break-all">{value}</span>
                                </SelectItem>
                              </>
                            ) : null}
                            {page?.revisions.map((row) => (
                              <SelectItem
                                key={row.revisionId}
                                value={row.revisionId}
                                disabled={row.revisionId === otherValue}
                                className="min-h-14 items-start whitespace-normal py-2 [&>:first-child]:min-w-0 [&>:first-child]:max-w-full [&>:first-child]:shrink [&>:first-child]:whitespace-normal [&>:first-child]:[overflow-wrap:anywhere]"
                              >
                                <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
                                  <span className="block break-words font-medium leading-snug">{row.title}</span>
                                  <time dateTime={row.createdAt} className="block text-xs text-muted-foreground">
                                    {formatHistoryDate(row.createdAt)}
                                  </time>
                                  <span className="block break-all text-xs text-muted-foreground">
                                    {row.revisionId}
                                  </span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  );
                })}
              </div>
            ) : null}
            <div className="flex min-w-0 flex-wrap items-start gap-3">
              <Button
                ref={compareTrigger}
                type="button"
                variant="outline"
                className={control}
                hidden={showComparison}
                aria-describedby={compareDescribedBy}
                disabled={
                  showComparison ||
                  pending ||
                  !operations ||
                  compareAdmission !== 'available' ||
                  !leftRevisionId ||
                  !rightRevisionId ||
                  leftRevisionId === rightRevisionId
                }
                onClick={(event) =>
                  void compare({ leftRevisionId, rightRevisionId }, compareTrigger.current, event)
                }
              >
                {m.knowledge_history_compare({}, options)}
              </Button>
              {!showComparison && compareAdmission === 'available' ? (
                <p
                  id={compareHelpId}
                  className="min-w-0 flex-1 basis-48 text-sm leading-relaxed text-muted-foreground"
                >
                  {m.knowledge_history_difference_help({}, options)}
                </p>
              ) : pair && !pending && compareState !== 'ready' && compareAdmission === 'available' ? (
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={!operations}
                  onClick={(event) => void compare(pair, returnTarget.current, event)}
                >
                  {m.knowledge_history_retry_pair({}, options)}
                </Button>
              ) : null}
            </div>
          </section>
          {showComparison ? (
            comparison ? (
              <KnowledgeHistoryComparisonView comparison={comparison} draft={draft} locale={locale} />
            ) : null
          ) : null}
          <div hidden={showComparison} className="min-w-0 space-y-5">
            {page ? (
              <>
                <ol className="min-w-0 divide-y divide-border">
                  {page.revisions.map((row) => (
                    <li key={row.revisionId} className="min-w-0 space-y-3 py-5">
                      <h3 className="min-w-0 font-semibold leading-snug [overflow-wrap:anywhere]">{row.title}</h3>
                      <p className="break-all font-mono text-xs text-muted-foreground">{row.revisionId}</p>
                      <time dateTime={row.createdAt} className="block text-sm tabular-nums text-muted-foreground">
                        {formatHistoryDate(row.createdAt)}
                      </time>
                      {leftRevisionId === row.revisionId || rightRevisionId === row.revisionId ? (
                        <p className="flex min-h-11 flex-wrap items-center gap-x-4 text-sm font-medium">
                          {leftRevisionId === row.revisionId ? m.knowledge_history_left({}, options) : null}
                          {rightRevisionId === row.revisionId ? m.knowledge_history_right({}, options) : null}
                        </p>
                      ) : null}
                      <KnowledgeDetails label={m.knowledge_workspace_details({}, options)}>
                        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
                          <div className="min-w-0">
                            <dt className="text-sm font-medium">{m.knowledge_private_language({}, options)}</dt>
                            <dd className="text-sm text-muted-foreground">{row.language ?? '—'}</dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-sm font-medium">{m.knowledge_private_licence({}, options)}</dt>
                            <dd className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                              {row.licence}
                            </dd>
                          </div>
                          <div className="min-w-0 sm:col-span-2">
                            <dt className="text-sm font-medium">{m.knowledge_history_digest({}, options)}</dt>
                            <dd className="break-all text-sm text-muted-foreground">{row.sha256}</dd>
                          </div>
                        </dl>
                      </KnowledgeDetails>
                    </li>
                  ))}
                </ol>
                {!page.revisions.length ? (
                  <p role="status">
                    {page.next === null
                      ? m.knowledge_history_empty({}, options)
                      : m.knowledge_history_sparse({}, options)}
                  </p>
                ) : null}
              </>
            ) : null}
            <div role="group" aria-label={m.knowledge_history_heading({}, options)} className="min-w-0 space-y-3">
              <h3 className="text-sm font-semibold">{m.knowledge_history_heading({}, options)}</h3>
              <div className="flex min-w-0 flex-wrap gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={
                    pending ||
                    admission !== 'available' ||
                    !operations ||
                    !page ||
                    !navigation.previous.length
                  }
                  onClick={(event) => void load(previousKnowledgeHistoryPage(navigation), event)}
                >
                  {m.knowledge_history_previous({}, options)}
                </Button>
                {page?.next ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={control}
                    disabled={pending || admission !== 'available' || !operations}
                    onClick={(event) => void load(nextKnowledgeHistoryPage(navigation, page.next!), event)}
                  >
                    {m.knowledge_history_more({}, options)}
                  </Button>
                ) : null}
                {pageState === 'unavailable' && attempt ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={control}
                    disabled={pending || admission !== 'available' || !operations}
                    onClick={(event) => void load(attempt, event)}
                  >
                    {m.knowledge_private_retry({}, options)}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={pending || admission !== 'available' || !operations}
                  onClick={(event) => void load(firstKnowledgeHistoryPage(), event)}
                >
                  {m.knowledge_history_restart({}, options)}
                </Button>
              </div>
              {page && navigation.truncated && !navigation.previous.length ? (
                <p role="status" className="max-w-prose text-sm text-muted-foreground">
                  {m.knowledge_history_window_edge({}, options)}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
