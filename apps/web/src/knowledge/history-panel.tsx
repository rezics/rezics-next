import { KnowledgeDetails, knowledgeControl } from './workspace';
import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { DocumentSnapshot } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
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
  return (
    <section
      id="knowledge-revisions"
      className="min-w-0 scroll-mt-6 space-y-5 border-t border-border pt-6"
      aria-label={m.knowledge_history_heading({}, options)}
    >
      <div className="flex min-w-0 flex-wrap gap-3">
        <Button
          ref={historyTrigger}
          type="button"
          variant="outline"
          className={control}
          disabled={pending || open || admission !== 'available' || !operations}
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
            onClick={(event) => void compare(conflictPair, conflictTrigger.current, event)}
          >
            {m.knowledge_history_compare_heads({}, options)}
          </Button>
        ) : null}
      </div>
      {admission !== 'available' ? <p role="status">{failureText(admission)}</p> : null}
      {open ? (
        <div className="min-w-0 space-y-6" aria-busy={pending}>
          <h2
            ref={heading}
            tabIndex={-1}
            className="text-lg font-semibold leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {showComparison ? m.knowledge_history_comparison({}, options) : m.knowledge_history_heading({}, options)}
          </h2>
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
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
          {showComparison ? (
            <>
              {pair ? (
                <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
                  {(['left', 'right'] as const).map((side) => (
                    <div key={side} className="min-w-0">
                      <dt className="text-sm font-medium">
                        {side === 'left'
                          ? m.knowledge_history_left({}, options)
                          : m.knowledge_history_right({}, options)}
                      </dt>
                      <dd className="break-all text-sm">
                        {side === 'left' ? pair.leftRevisionId : pair.rightRevisionId}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {comparison ? (
                <KnowledgeHistoryComparisonView
                  comparison={comparison}
                  draft={conflictPair ? draft : null}
                  locale={locale}
                />
              ) : null}
              {pair && !pending && compareState !== 'ready' ? (
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  onClick={(event) => void compare(pair, returnTarget.current, event)}
                >
                  {m.knowledge_history_retry_pair({}, options)}
                </Button>
              ) : null}
            </>
          ) : null}
          <div hidden={showComparison} className="min-w-0 space-y-5">
            {page ? (
              <>
                <ol className="min-w-0 divide-y divide-border">
                  {page.revisions.map((row) => (
                    <li key={row.revisionId} className="min-w-0 space-y-3 py-5">
                      <h3 className="font-semibold leading-snug">{row.title}</h3>
                      <p className="break-all text-sm">{row.revisionId}</p>
                      <time dateTime={row.createdAt} className="block text-sm tabular-nums text-muted-foreground">
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: 'medium',
                          timeStyle: 'long',
                          timeZone: 'UTC',
                        }).format(new Date(row.createdAt))}
                      </time>
                      <KnowledgeDetails label={m.knowledge_workspace_details({}, options)}>
                        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
                          <div>
                            <dt className="text-sm font-medium">{m.knowledge_private_language({}, options)}</dt>
                            <dd className="text-sm text-muted-foreground">{row.language ?? '—'}</dd>
                          </div>
                          <div>
                            <dt className="text-sm font-medium">{m.knowledge_private_licence({}, options)}</dt>
                            <dd className="break-words text-sm text-muted-foreground">{row.licence}</dd>
                          </div>
                          <div className="min-w-0 sm:col-span-2">
                            <dt className="text-sm font-medium">{m.knowledge_history_digest({}, options)}</dt>
                            <dd className="break-all text-sm text-muted-foreground">{row.sha256}</dd>
                          </div>
                        </dl>
                      </KnowledgeDetails>
                      <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-2">
                        {(['left', 'right'] as const).map((side) => (
                          <label key={side} className="flex min-h-11 min-w-11 cursor-pointer items-center gap-3 py-2">
                            <input
                              type="radio"
                              aria-label={`${side === 'left' ? m.knowledge_history_left({}, options) : m.knowledge_history_right({}, options)}: ${row.revisionId}`}
                              name={`${id}-${side}`}
                              value={row.revisionId}
                              checked={(side === 'left' ? leftRevisionId : rightRevisionId) === row.revisionId}
                              disabled={pending}
                              onChange={() => {
                                if (!live.current || !isCurrent()) return;
                                focus.cancel();
                                if (side === 'left') setLeft(row.revisionId);
                                else setRight(row.revisionId);
                              }}
                              className="size-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            />
                            <span>
                              {side === 'left'
                                ? m.knowledge_history_left({}, options)
                                : m.knowledge_history_right({}, options)}
                              <span className="sr-only">: {row.revisionId}</span>
                            </span>
                          </label>
                        ))}
                      </div>
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
            <div className="min-w-0 space-y-3">
              <p className="break-all text-sm">
                {m.knowledge_history_left({}, options)}: {leftRevisionId || '—'}
              </p>
              <p className="break-all text-sm">
                {m.knowledge_history_right({}, options)}: {rightRevisionId || '—'}
              </p>
              <div className="flex min-w-0 flex-wrap gap-3">
                <Button
                  ref={compareTrigger}
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={
                    pending ||
                    compareAdmission !== 'available' ||
                    !leftRevisionId ||
                    !rightRevisionId ||
                    leftRevisionId === rightRevisionId
                  }
                  onClick={(event) => void compare({ leftRevisionId, rightRevisionId }, compareTrigger.current, event)}
                >
                  {m.knowledge_history_compare({}, options)}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={pending || !page || !navigation.previous.length}
                  onClick={(event) => void load(previousKnowledgeHistoryPage(navigation), event)}
                >
                  {m.knowledge_history_previous({}, options)}
                </Button>
                {page?.next ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={control}
                    disabled={pending}
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
                    disabled={pending}
                    onClick={(event) => void load(attempt, event)}
                  >
                    {m.knowledge_private_retry({}, options)}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={pending}
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
              {compareAdmission !== 'available' ? <p role="status">{failureText(compareAdmission)}</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
