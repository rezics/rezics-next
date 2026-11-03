import {
  useCatalogueLifetime,
  type CandidateSessionLease,
} from '../../subject/candidate-lifetime';
import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type MouseEvent, type Ref } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { SubjectFrame, ViewHeading } from '../pages/subject-frame';
import { viewTabLabels } from '../pages/route-support';
import { languageName } from '../../subject/language';
import { candidateContext } from '../../subject/candidates';
import type { CurrentCandidateAddress } from './subject-changes-navigation';
import {
  appendChangePage,
  firstChangePage,
  saveSubjectChangesReturn,
  type ChangePageHistory,
  type SubjectChangesReturn,
} from './subject-changes-navigation';
import type { TermField } from './subject-terms';
import { m } from '../../paraglide/messages.js';
import {
  changesState,
  type ChangeDetail,
  type ChangesFailure,
  type ChangesState,
  type ChangesTransport,
} from './subject-changes';

type FocusResult =
  | { kind: 'batch'; revision?: number | undefined; count: number; next: string | null }
  | { kind: 'detail' | 'failure' };

type ChangeAction = MouseEvent<HTMLButtonElement>;
type FocusIntent = { opener: HTMLButtonElement; cancel: () => void };

type Props = {
  rootRef?: Ref<HTMLElement>;
  focusResult?: FocusResult | undefined;
  state: ChangesState;
  locale: string;
  currentHref?: string;
  onMore?: (event: ChangeAction) => void;
  onSelect?: (revision: number, event: ChangeAction) => void;
  onRetry?: (event: ChangeAction) => void;
  onDetailRetry?: (event: ChangeAction) => void;
  onReviewCandidate?: (address: CurrentCandidateAddress, href: string, revision: number) => boolean;
  returnUnavailable?: boolean;
  historyTruncated?: boolean;
  onStartOver?: () => void;
};
const actionClassName =
  'relative z-10 h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const currentLinkClassName =
  'relative z-10 inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function Failure({ failure, locale }: { failure: ChangesFailure; locale: string }) {
  const o = { locale: locale as never };
  return (
    <p role="alert">
      {failure.kind === 'missing'
        ? m.changes_missing({}, o)
        : failure.kind === 'denied'
          ? m.changes_denied({}, o)
          : failure.kind === 'invalid'
            ? m.changes_invalid({}, o)
            : failure.kind === 'conflict'
              ? m.changes_conflict({}, o)
              : m.changes_unavailable({}, o)}
    </p>
  );
}
function revisionKind(kind: string, locale: string) {
  const o = { locale: locale as never };
  return kind === 'propose'
    ? m.changes_proposal({}, o)
    : kind === 'accept'
      ? m.changes_acceptance({}, o)
      : kind === 'reject'
        ? m.changes_rejection({}, o)
        : kind === 'adopt'
          ? m.changes_adoption({}, o)
          : m.changes_recorded({}, o);
}
function currentReviewHref(pageHref: string | undefined, address: CurrentCandidateAddress) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !pageHref?.startsWith('/') ||
    pageHref.startsWith('//') ||
    pageHref.includes('\\') ||
    !uuid.test(address.subject) ||
    !uuid.test(address.candidate) ||
    !uuid.test(address.context) ||
    !address.property ||
    address.property.length > 256
  )
    return undefined;
  const query = new URLSearchParams({
    reviewProperty: address.property,
    candidate: address.candidate,
    context: address.context,
    returnTo: 'changes',
  });
  return `${pageHref.replace(/\/$/, '')}/edit?${query.toString()}`;
}

function CurrentReviewLink({
  pageHref,
  address,
  revision,
  onReviewCandidate,
}: {
  pageHref?: string | undefined;
  address: CurrentCandidateAddress;
  revision: number;
  onReviewCandidate?: Props['onReviewCandidate'];
}) {
  const href = currentReviewHref(pageHref, address);
  if (!href || !onReviewCandidate) return null;
  return (
    <Link
      className={`${actionClassName} inline-flex items-center text-primary underline-offset-4 hover:underline`}
      to={href as never}
      onClick={(event) => {
        if (!onReviewCandidate(address, `${pageHref!.replace(/\/$/, '')}/changes`, revision)) event.preventDefault();
      }}
    >
      {m.changes_review_current()}
    </Link>
  );
}

export function ChangeExplanation({
  detail,
  revision,
  locale,
  pageHref,
  onReviewCandidate,
}: {
  detail: ChangeDetail;
  revision: number;
  locale: string;
  pageHref?: string | undefined;
  onReviewCandidate?: Props['onReviewCandidate'];
}) {
  const o = { locale: locale as never };
  const summary = detail.summary;
  const reading = summary.kind === 'candidate' || summary.kind === 'decision' ? summary.reading : undefined;
  const rank = (value: 'normal' | 'preferred' | 'deprecated') =>
    value === 'normal'
      ? m.candidate_rank_normal({}, o)
      : value === 'preferred'
        ? m.candidate_rank_preferred({}, o)
        : m.changes_rank_deprecated({}, o);
  const field = (kind: TermField) =>
    kind === 'labels'
      ? m.changes_name({}, o)
      : kind === 'descriptions'
        ? m.changes_description({}, o)
        : m.changes_aliases({}, o);
  return (
    <div className="min-w-0 space-y-3">
      <p>
        {summary.kind === 'limited'
          ? m.changes_limited({}, o)
          : summary.kind === 'terms'
            ? m.changes_terms({}, o)
            : summary.kind === 'candidate'
              ? m.changes_proposal_detail({}, o)
              : summary.kind === 'decision'
                ? summary.decision === 'accept'
                  ? m.changes_accepted_detail({}, o)
                  : summary.decision === 'reject'
                    ? m.changes_rejected_detail({}, o)
                    : m.changes_abstained_detail({}, o)
                : m.changes_adopted_detail({}, o)}
      </p>
      {summary.kind === 'terms' && (
        <dl className="space-y-2 text-sm" aria-label={m.changes_fields({}, o)}>
          {summary.fields.map((entry, index) => (
            <div key={index}>
              <dt className="text-muted-foreground">{field(entry.field)}</dt>
              <dd>
                {entry.languages
                  .map((tag) => languageName(tag, locale) ?? m.subject_value_unlabelled({}, o))
                  .join(' · ')}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {detail.propertyLabel?.text && (
        <p lang={detail.propertyLabel.lang} className="font-medium">
          {detail.propertyLabel.text}
        </p>
      )}
      {'context' in summary && summary.context && (
        <dl className="space-y-2 text-sm">
          <dt className="text-muted-foreground">{m.context_title({}, o)}</dt>
          <dd>{summary.context === candidateContext ? m.context_global({}, o) : m.context_unnamed({}, o)}</dd>
        </dl>
      )}
      {reading && (
        <section className="space-y-2 text-sm" aria-label={m.changes_current({}, o)}>
          <h3 className="font-medium">{m.changes_current({}, o)}</h3>
          <p>
            {reading.decision === null
              ? m.candidate_unresolved({}, o)
              : reading.decision.verdict === 'accept'
                ? m.context_accepted({}, o)
                : reading.decision.verdict === 'reject'
                  ? m.candidate_rejected_state({}, o)
                  : m.changes_abstained_detail({}, o)}
          </p>
          <p>{reading.selected ? m.context_selected({}, o) : m.value_not_selected({}, o)}</p>
          {reading.rank !== null && (
            <p>
              {m.candidate_rank({}, o)}: {rank(reading.rank)}
            </p>
          )}
        </section>
      )}
      {(summary.kind === 'candidate' || summary.kind === 'decision') &&
        summary.candidate &&
        summary.property && (
          <section className="space-y-2" aria-label={m.changes_review_current({}, o)}>
            <p className="text-sm text-muted-foreground">{m.changes_review_notice({}, o)}</p>
            <CurrentReviewLink
              pageHref={pageHref}
              address={{
                subject: detail.id,
                property: summary.property,
                candidate: summary.candidate,
                context: summary.context ?? candidateContext,
              }}
              revision={revision}
              onReviewCandidate={onReviewCandidate}
            />
          </section>
        )}
      {summary.kind === 'adoption' && (
        <section className="space-y-2 text-sm" aria-label={m.changes_recorded({}, o)}>
          <h3 className="font-medium">{m.changes_recorded({}, o)}</h3>
          {summary.mode && (
            <p>
              {m.context_mode({}, o)}:{' '}
              {summary.mode === 'inherit'
                ? m.context_inherit({}, o)
                : summary.mode === 'replace'
                  ? m.context_replace({}, o)
                  : m.context_suppress({}, o)}
            </p>
          )}
          <ol className="space-y-2">
            {summary.selection?.slice(0, 32).map((entry, index) => (
              <li key={entry.candidate} className="space-y-1">
                <span className="block">
                  {m.facts_selected_value({ number: String(index + 1) }, o)} · {rank(entry.rank)}
                </span>
                <CurrentReviewLink
                  pageHref={pageHref}
                  address={{
                    subject: detail.id,
                    property: summary.property,
                    candidate: entry.candidate,
                    context: summary.context,
                  }}
                  revision={revision}
                  onReviewCandidate={onReviewCandidate}
                />
              </li>
            ))}
          </ol>
          <p className="text-sm text-muted-foreground">{m.changes_choose_candidate({}, o)}</p>
          <p className="text-sm text-muted-foreground">{m.changes_review_notice({}, o)}</p>
        </section>
      )}
    </div>
  );
}

/** Shared subject frame and controls; no historical payload, actor or raw identifier is rendered. */
export function SubjectChangesPage({
  state,
  locale,
  currentHref,
  onMore,
  onSelect,
  onRetry,
  onDetailRetry,
  onReviewCandidate,
  returnUnavailable,
  historyTruncated,
  onStartOver,
  rootRef,
  focusResult,
}: Props) {
  const explanationHeadingId = useId();
  const o = { locale: locale as never };
  const busy = !!state.loading;
  const page = state.page;
  const detail = state.detail?.kind === 'ready' ? state.detail.detail : undefined;
  const reading =
    detail?.summary.kind === 'candidate' || detail?.summary.kind === 'decision' ? detail.summary.reading : undefined;
  const batch = focusResult?.kind === 'batch' ? focusResult : undefined;
  const batchBoundary = batch && (
    <p tabIndex={-1} data-changes-focus="batch" className="text-sm text-muted-foreground">
      {batch.next === null
        ? m.subject_relation_completed_end({ label: m.changes_revisions({}, o), count: String(batch.count) }, o)
        : m.subject_relation_completed_more({ label: m.changes_revisions({}, o), count: String(batch.count) }, o)}
    </p>
  );
  return (
    <article
      ref={rootRef}
      data-slot="subject-changes"
      className="flex min-w-0 flex-col gap-8 [overflow-wrap:anywhere]"
      aria-busy={busy}
    >
      {page && (
        <SubjectFrame
          frame={{ id: page.id, title: page.title, type: '', summary: null }}
          locale={locale}
          unlabelled={m.subject_value_unlabelled({}, o)}
          typeLabel={page.typeLabel.text}
          tabs={[]}
          tabLabels={viewTabLabels()}
          view="details"
          navigation={
            <nav
              aria-label={m.changes_title({}, o)}
              className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-sm"
            >
              <a className={currentLinkClassName} href={page.href}>
                {m.changes_current({}, o)}
              </a>
              <span aria-current="page" className="font-medium">
                {m.changes_title({}, o)}
              </span>
            </nav>
          }
        />
      )}
      <header className="space-y-2">
        <ViewHeading label={m.changes_title({}, o)} headingClassName="font-sans" />
        <p className="max-w-prose text-sm text-muted-foreground">{m.changes_intro({}, o)}</p>
      </header>
      {!page && currentHref && (
        <a className={`${currentLinkClassName} text-sm text-primary`} href={currentHref}>
          {m.changes_current({}, o)}
        </a>
      )}
      {state.loading === 'list' && <p role="status">{m.changes_loading({}, o)}</p>}
      {historyTruncated && <p role="status">{m.changes_history_truncated({}, o)}</p>}
      {returnUnavailable && (
        <div className="space-y-2" role="status">
          <p>{m.changes_return_unavailable({}, o)}</p>
          {onStartOver && (
            <Button variant="outline" className={actionClassName} onClick={onStartOver}>
              {m.changes_start_over({}, o)}
            </Button>
          )}
        </div>
      )}
      {state.failure && (
        <div className="space-y-3" tabIndex={-1} data-changes-focus="failure">
          <Failure failure={state.failure} locale={locale} />
          {state.failure.kind !== 'missing' && onRetry && (
            <Button variant="outline" className={actionClassName} disabled={busy} onClick={onRetry}>
              {m.changes_retry({}, o)}
            </Button>
          )}
        </div>
      )}
      {page && (
        <div className="grid min-w-0 gap-8 md:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]">
          <section className="min-w-0 space-y-4" aria-label={m.changes_revisions({}, o)}>
            <ContentItemHeading level={2} className="text-xl font-semibold">
              {m.changes_revisions({}, o)}
            </ContentItemHeading>
            {!page.revisions.length && (
              <p className="text-muted-foreground">
                {page.next === null ? m.changes_empty({}, o) : m.changes_empty_page({}, o)}
              </p>
            )}
            <ol className="space-y-2">
              {page.revisions.map((row) => (
                <li key={row.revision}>
                  {batch?.revision === row.revision && batchBoundary}
                  <ContentItemFrame as="div" className="min-w-0">
                    <Button
                      variant={state.selected === row.revision ? 'secondary' : 'ghost'}
                      className={`${actionClassName} w-full justify-start py-3 text-start`}
                      aria-pressed={state.selected === row.revision}
                      disabled={busy || !onSelect}
                      onClick={(event) => onSelect?.(row.revision, event)}
                    >
                      <span className="flex min-w-0 max-w-full flex-col gap-1">
                        <span>{m.changes_revision({ revision: String(row.revision) }, o)}</span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {revisionKind(row.kind, locale)}
                        </span>
                      </span>
                    </Button>
                  </ContentItemFrame>
                </li>
              ))}
            </ol>
            {batch && batch.revision === undefined && batchBoundary}
            {page.next !== null && onMore && (
              <Button variant="outline" className={actionClassName} disabled={busy} onClick={onMore}>
                {m.changes_more({}, o)}
              </Button>
            )}
            {state.loading === 'more' && <p role="status">{m.changes_loading({}, o)}</p>}
          </section>
          {!!page.revisions.length && (
            <section aria-labelledby={explanationHeadingId} className="min-w-0">
              <ContentItemFrame as="div" className="min-w-0 space-y-4 p-4 sm:p-5">
                <ContentItemHeading
                  level={2}
                  id={explanationHeadingId}
                  tabIndex={-1}
                  data-changes-focus="detail"
                  className="text-xl font-semibold"
                >
                  {state.selected
                    ? m.changes_revision({ revision: String(state.selected) }, o)
                    : m.changes_explanation({}, o)}
                </ContentItemHeading>
                {state.selected === undefined && <p className="text-muted-foreground">{m.changes_choose({}, o)}</p>}
                {state.loading === 'detail' && <p role="status">{m.changes_detail_loading({}, o)}</p>}
                {state.detail && state.detail.kind !== 'ready' && (
                  <div className="space-y-3" tabIndex={-1} data-changes-focus="detail-failure">
                    <Failure failure={state.detail} locale={locale} />
                    {onDetailRetry && (
                      <Button variant="outline" className={actionClassName} disabled={busy} onClick={onDetailRetry}>
                        {m.changes_retry_detail({}, o)}
                      </Button>
                    )}
                  </div>
                )}
                {detail && !reading && (
                  <p className="text-sm text-muted-foreground">{m.changes_current_notice({}, o)}</p>
                )}
                {detail && (
                  <ChangeExplanation
                    detail={detail}
                    revision={detail.revision}
                    locale={locale}
                    pageHref={page?.href}
                    onReviewCandidate={onReviewCandidate}
                  />
                )}
              </ContentItemFrame>
            </section>
          )}
        </div>
      )}
    </article>
  );
}

/** Each admitted visit owns its private list, selected explanation and native continuation. */
export function SubjectChanges(props: {
  locale: string;
  transport: ChangesTransport;
  currentHref?: string;
  lease?: CandidateSessionLease;
  initialReturn?: SubjectChangesReturn;
}) {
  const work = useCatalogueLifetime(JSON.stringify([props.locale, props.currentHref]));
  return <SubjectChangesReader key={work.generation} {...props} work={work} />;
}

function SubjectChangesReader({
  locale,
  transport,
  currentHref,
  lease,
  initialReturn,
  work,
}: {
  locale: string;
  transport: ChangesTransport;
  currentHref?: string;
  lease?: CandidateSessionLease;
  initialReturn?: SubjectChangesReturn;
  work: ReturnType<typeof useCatalogueLifetime>;
}) {
  const [state, dispatch] = useReducer(changesState, { loading: 'list' });
  const [focusResult, setFocusResult] = useState<FocusResult>();
  const focusRoot = useRef<HTMLElement>(null);
  const focusIntent = useRef<FocusIntent | null>(null);
  const session = useRef<string | undefined>(undefined);
  const running = useRef<number | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  // A callback refresh is not a new admitted Subject/locale address.
  const currentTransport = useRef(transport);
  currentTransport.current = transport;
  const retryCursor = useRef<string | undefined>(undefined);
  const historyRef = useRef<ChangePageHistory>(initialReturn?.history ?? firstChangePage());
  const [historyTruncated, setHistoryTruncated] = useState(historyRef.current.truncated);
  const [returnUnavailable, setReturnUnavailable] = useState(false);
  const revisionAddresses = useRef(new Map<number, string | undefined>());
  const latest = useRef(state);
  latest.current = state;
  const active = () => mounted.current && work.active();
  useLayoutEffect(() => {
    if (!focusResult) return;
    const intent = focusIntent.current;
    if (!intent) return;
    const document = intent.opener.ownerDocument;
    const held = document.activeElement === intent.opener || document.activeElement === document.body;
    // Consume before focusing: a later successful read cannot revive this handoff.
    intent.cancel();
    if (!active() || !held) return;
    const kind =
      focusResult.kind === 'detail'
        ? !state.page
          ? 'failure'
          : state.detail && state.detail.kind !== 'ready'
            ? 'detail-failure'
            : 'detail'
        : focusResult.kind;
    const boundary = focusRoot.current?.querySelector<HTMLElement>(`[data-changes-focus="${kind}"]`);
    (boundary?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? boundary)?.focus();
  }, [focusResult]);
  useLayoutEffect(() => () => focusIntent.current?.cancel(), []);
  function begin(event?: ChangeAction) {
    if (!active() || running.current !== null) return;
    focusIntent.current?.cancel();
    const opener = event?.currentTarget;
    const document = opener?.ownerDocument;
    if (event?.detail === 0 && opener?.isConnected && document?.activeElement === opener) {
      const cancel = () => {
        document.removeEventListener('focusin', moved, true);
        document.removeEventListener('pointerdown', cancel, true);
        document.removeEventListener('keydown', tabbed, true);
        document.defaultView?.removeEventListener('blur', cancel);
        if (focusIntent.current?.cancel === cancel) focusIntent.current = null;
      };
      const moved = (event: FocusEvent) => {
        if (event.target !== opener) cancel();
      };
      const tabbed = (event: KeyboardEvent) => {
        if (event.key === 'Tab') cancel();
      };
      focusIntent.current = { opener, cancel };
      document.addEventListener('focusin', moved, true);
      document.addEventListener('pointerdown', cancel, true);
      document.addEventListener('keydown', tabbed, true);
      document.defaultView?.addEventListener('blur', cancel);
    }
    const operation = ++sequence.current;
    running.current = operation;
    setFocusResult(undefined);
    return {
      current: () => active() && running.current === operation,
      finish: () => {
        if (running.current === operation) running.current = null;
      },
    };
  }
  useEffect(() => {
    mounted.current = true;
    if (initialReturn) void restore(initialReturn);
    else void load();
    return () => {
      mounted.current = false;
      running.current = null;
    };
  }, [work]);
  async function load(cursor?: string, explicit = cursor !== undefined, event?: ChangeAction) {
    // A continuation belongs only to the page that supplied it, including retries.
    if (cursor !== undefined && cursor !== latest.current.page?.next) return;
    const operation = begin(event);
    if (!operation) return;
    retryCursor.current = cursor;
    const previous = new Set(latest.current.page?.revisions.map((row) => row.revision));
    dispatch({ type: 'list-start', more: cursor !== undefined });
    const finish = (result: Parameters<typeof changesState>[1] & { type: 'list' }) => {
      dispatch(result);
      if (!explicit) return;
      const admitted =
        result.result.kind === 'ready' && (!latest.current.page || result.result.page.id === latest.current.page.id);
      const rows =
        admitted && result.result.kind === 'ready'
          ? [...new Map(result.result.page.revisions.map((row) => [row.revision, row])).values()].filter(
              (row) => !previous.has(row.revision),
            )
          : [];
      setFocusResult(
        admitted && result.result.kind === 'ready'
          ? { kind: 'batch', revision: rows[0]?.revision, count: rows.length, next: result.result.page.next }
          : { kind: 'failure' },
      );
    };
    try {
      const result = await currentTransport.current.list(cursor, session.current);
      if (!operation.current()) return;
      if (result.kind === 'ready') {
        session.current = result.session ?? session.current;
        if (cursor === undefined && !explicit) {
          historyRef.current = firstChangePage();
          revisionAddresses.current.clear();
          setHistoryTruncated(false);
        } else if (cursor !== undefined) {
          historyRef.current = appendChangePage(historyRef.current, cursor);
          setHistoryTruncated(historyRef.current.truncated);
        }
        const retainedAddresses = new Set(historyRef.current.addresses);
        for (const [revision, address] of revisionAddresses.current)
          if (!retainedAddresses.has(address)) revisionAddresses.current.delete(revision);
        for (const row of result.page.revisions) revisionAddresses.current.set(row.revision, cursor);
        while (revisionAddresses.current.size > 100)
          revisionAddresses.current.delete(revisionAddresses.current.keys().next().value!);
      }
      finish({ type: 'list', result, more: cursor !== undefined });
    } catch {
      if (operation.current()) finish({ type: 'list', result: { kind: 'unavailable' }, more: cursor !== undefined });
    } finally {
      operation.finish();
    }
  }
  async function select(revision: number, event?: ChangeAction) {
    if (!latest.current.page?.revisions.some((row) => row.revision === revision)) return;
    const operation = begin(event);
    if (!operation) return;
    dispatch({ type: 'detail-start', revision });
    try {
      const result = await currentTransport.current.detail(revision, session.current);
      if (!operation.current()) return;
      if (result.kind === 'ready') session.current = result.session ?? session.current;
      dispatch({ type: 'detail', result });
      setFocusResult({ kind: 'detail' });
    } catch {
      if (operation.current()) {
        dispatch({ type: 'detail', result: { kind: 'unavailable' } });
        setFocusResult({ kind: 'detail' });
      }
    } finally {
      operation.finish();
    }
  }
  async function restore(visit: SubjectChangesReturn) {
    const operation = begin();
    if (!operation) return;
    const history = visit.history;
    let found = false;
    let chainNext: string | null | undefined;
    try {
      if (!visit.lease.current() || visit.subject !== visit.id || visit.revision < 1) throw new Error('Expired history visit');
      for (let index = 0; index < history.addresses.length; index++) {
        const cursor = history.addresses[index];
        if (index > 0 && cursor !== chainNext) throw new Error('Expired history continuation');
        dispatch({ type: 'list-start', more: index > 0 });
        const result = await currentTransport.current.list(cursor, session.current);
        if (!operation.current() || !visit.lease.current()) return;
        if (result.kind !== 'ready') throw new Error('History page unavailable');
        session.current = result.session ?? session.current;
        chainNext = result.page.next;
        for (const row of result.page.revisions) {
          revisionAddresses.current.set(row.revision, cursor);
          if (row.revision === visit.revision) found = true;
        }
        dispatch({ type: 'list', result, more: index > 0 });
        if (index + 1 < history.addresses.length && result.page.next !== history.addresses[index + 1])
          throw new Error('History continuation changed');
      }
      setHistoryTruncated(history.truncated);
      setReturnUnavailable(!found);
      dispatch({ type: 'detail-start', revision: visit.revision });
      if (found) {
        const result = await currentTransport.current.detail(visit.revision, session.current);
        if (!operation.current() || !visit.lease.current()) return;
        if (result.kind === 'ready') session.current = result.session ?? session.current;
        dispatch({ type: 'detail', result });
        setReturnUnavailable(result.kind !== 'ready');
      } else {
        dispatch({ type: 'detail', result: { kind: 'unavailable' } });
      }
      setFocusResult({ kind: 'detail' });
    } catch {
      if (operation.current()) {
        setReturnUnavailable(true);
        dispatch({ type: 'detail-start', revision: visit.revision });
        dispatch({ type: 'detail', result: { kind: 'unavailable' } });
        setFocusResult({ kind: 'detail' });
      }
    } finally {
      operation.finish();
    }
  }
  function startOver() {
    if (!active()) return;
    setReturnUnavailable(false);
    historyRef.current = firstChangePage();
    setHistoryTruncated(false);
    revisionAddresses.current.clear();
    void load(undefined, false);
  }
  function reviewCandidate(address: CurrentCandidateAddress, href: string, revision: number) {
    const page = latest.current.page;
    if (
      !lease ||
      !lease.current() ||
      !active() ||
      !page ||
      latest.current.selected !== revision ||
      !revisionAddresses.current.has(revision)
    )
      return false;
    const cursor = revisionAddresses.current.get(revision);
    if (!historyRef.current.addresses.includes(cursor)) return false;
    return saveSubjectChangesReturn({
      id: page.id,
      subject: page.id,
      href,
      locale,
      history: { addresses: [...historyRef.current.addresses], truncated: historyRef.current.truncated },
      revision,
      address,
      lease,
    });
  }
  return (
    <SubjectChangesPage
      rootRef={focusRoot}
      focusResult={focusResult}
      state={state}
      locale={locale}
      historyTruncated={historyTruncated}
      returnUnavailable={returnUnavailable}
      onStartOver={startOver}
      {...(lease ? { onReviewCandidate: reviewCandidate } : {})}
      {...(currentHref ? { currentHref } : {})}
      onMore={(event) => {
        const cursor = state.page?.next;
        if (cursor !== null && cursor !== undefined && cursor === latest.current.page?.next)
          void load(cursor, true, event);
      }}
      onRetry={(event) => {
        if (state !== latest.current) return;
        const cursor = retryCursor.current;
        void load(cursor !== undefined && cursor === state.page?.next ? cursor : undefined, true, event);
      }}
      onSelect={(revision, event) => {
        void select(revision, event);
      }}
      onDetailRetry={(event) => {
        if (state.selected !== undefined && state === latest.current) void select(state.selected, event);
      }}
    />
  );
}
