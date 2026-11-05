import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { DynamicCollectionPage as DynamicCollectionPageData } from '../dynamic-collection';
import type { RulePage } from '../collection-rule-read';
import { useCollectionOwnerCurrent } from '../collection-owner-current';
import { RuleEditLink } from '../saved-query-results';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { DynamicRuleReview, ruleReviewReleaseFromChoices, type RuleReviewRelease } from './criteria';

type ResultsPage = Pick<
  DynamicCollectionPageData,
  | 'id'
  | 'title'
  | 'curatorAccountId'
  | 'builtinKind'
  | 'members'
  | 'cursor'
  | 'next'
  | 'preparing'
  | 'unavailable'
  | 'filterIgnored'
  | 'filterStatus'
  | 'cursorRestarted'
>;

type ReviewState =
  | { binding: string; phase: 'closed' | 'reading' | 'denied' | 'unavailable' }
  | { binding: string; phase: 'ready'; page: Extract<RulePage, { state: 'ready' }> };

const buttonClass =
  'inline-flex min-h-11 min-w-0 max-w-full items-center justify-center break-words rounded-lg border border-border px-4 py-2 text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

/** An owner-only private read joins the admitted rule basis to this exact dynamic results page. */
export function DynamicRuleResultsReview({
  page,
  viewerId,
  resultsHref,
  read = async (id) => {
    const { readCollectionRule } = await import('../collection-rule-actions');
    return readCollectionRule({ data: id });
  },
}: {
  page: ResultsPage;
  viewerId: string | null;
  resultsHref: string;
  read?: (id: string) => Promise<RulePage>;
}) {
  const owner = useCollectionOwnerCurrent(JSON.stringify(['dynamic-rule-results', page.id]), true);
  const headingId = useId();
  const locale = getLocale();
  const ownerId = page.curatorAccountId ?? null;
  const binding = JSON.stringify([page.id, ownerId, viewerId, owner.subject, owner.generation, owner.lifetime, locale]);
  const bindingRef = useRef(binding);
  const sequence = useRef(0);
  const ownerCurrentRef = useRef<() => boolean>(() => false);
  const liveOwner = () =>
    !!viewerId &&
    ownerId === viewerId &&
    owner.subject === viewerId &&
    owner.admitted &&
    owner.isCurrent() &&
    owner.isOwnerCurrent() &&
    owner.operationCurrent('collection.get');
  bindingRef.current = binding;
  ownerCurrentRef.current = liveOwner;
  const [state, setState] = useState<ReviewState>({ binding, phase: 'closed' });
  const visible = state.binding === binding ? state : ({ binding, phase: 'closed' } as const);

  useLayoutEffect(() => {
    sequence.current += 1;
    setState({ binding, phase: 'closed' });
  }, [binding]);
  useLayoutEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );

  if (page.builtinKind || !liveOwner()) return null;

  function current(request: number, expected: string) {
    return bindingRef.current === expected && sequence.current === request && ownerCurrentRef.current();
  }

  async function openReview() {
    if (!ownerCurrentRef.current()) return;
    const expected = binding;
    const request = ++sequence.current;
    setState({ binding: expected, phase: 'reading' });
    try {
      const result = await read(page.id);
      if (!current(request, expected)) return;
      if (result.state === 'denied') {
        setState({ binding: expected, phase: 'denied' });
        return;
      }
      if (result.state === 'unavailable') {
        setState({ binding: expected, phase: 'unavailable' });
        return;
      }
      if (
        result.state !== 'ready' ||
        result.id !== page.id ||
        result.viewerId !== ownerId ||
        result.address?.collectionId !== page.id
      ) {
        setState({ binding: expected, phase: 'denied' });
        return;
      }
      setState({ binding: expected, phase: 'ready', page: result });
    } catch {
      if (current(request, expected)) setState({ binding: expected, phase: 'unavailable' });
    }
  }

  function closeReview() {
    sequence.current += 1;
    setState({ binding, phase: 'closed' });
  }

  return (
    <section className="min-w-0 space-y-3 rounded-xl border border-border p-4" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id={headingId} className="text-lg font-semibold">
            {m.library_rule_results_heading()}
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">{m.library_rule_review_no_evaluation()}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {visible.phase === 'ready' ? (
            <button type="button" className={buttonClass} onClick={closeReview}>
              {m.library_rule_results_close()}
            </button>
          ) : (
            <button
              type="button"
              className={buttonClass}
              disabled={visible.phase === 'reading' || !ownerCurrentRef.current()}
              onClick={() => void openReview()}
            >
              {visible.phase === 'reading'
                ? m.library_rule_results_loading()
                : visible.phase === 'unavailable' || visible.phase === 'denied'
                  ? m.library_rule_results_retry()
                  : m.library_rule_results_review()}
            </button>
          )}
          <RuleEditLink
            collection={{ id: page.id, curatorAccountId: ownerId, membershipKind: 'dynamic' }}
            viewerId={viewerId}
            allowed={liveOwner()}
            resultsHref={resultsHref}
            className={buttonClass}
          />
        </div>
      </div>
      {visible.phase === 'reading' ? <p role="status">{m.library_rule_results_loading()}</p> : null}
      {visible.phase === 'denied' ? <p role="alert">{m.library_rule_denied()}</p> : null}
      {visible.phase === 'unavailable' ? <p role="alert">{m.library_rule_unavailable()}</p> : null}
      {visible.phase === 'ready' ? (
        <>
          <ResultsResponse page={page} basisState={acceptedMeaning(visible.page).state} />
          <DynamicRuleReview
            filter={visible.page.rule.filter}
            stage="saved"
            current={ruleReviewReleaseFromChoices(visible.page.choices)}
            accepted={acceptedMeaning(visible.page)}
            choices={visible.page.choices}
            profiles={visible.page.accepted?.profiles ?? []}
            profileState={visible.page.accepted?.state ?? 'unavailable'}
            basis={visible.page.rule}
            basisKind="loaded"
            basisExpanded
            collectionId={visible.page.id}
            locale={locale}
            ownerCurrent={liveOwner()}
          />
        </>
      ) : null}
    </section>
  );
}

function acceptedMeaning(page: Extract<RulePage, { state: 'ready' }>): RuleReviewRelease {
  return page.accepted && page.accepted.digest === page.rule.releaseDigest
    ? {
        state: page.accepted.state,
        digest: page.accepted.digest,
        ...(page.accepted.metadata ? { metadata: page.accepted.metadata } : {}),
      }
    : { state: 'unavailable', digest: page.rule.releaseDigest };
}

function ResultsResponse({ page, basisState }: { page: ResultsPage; basisState: RuleReviewRelease['state'] }) {
  const incomplete =
    !!page.filterIgnored?.length || page.filterStatus === 'unsupported' || page.filterStatus === 'failed';
  const ready =
    !page.preparing && !page.unavailable && page.filterStatus !== 'preparing' && basisState === 'ready' && !incomplete;
  const empty = ready && page.members.length === 0;
  const exhausted = page.cursor === undefined && page.next === null;
  let status: string;
  if (page.unavailable) status = m.library_dynamic_unavailable();
  else if (page.preparing || page.filterStatus === 'preparing') status = m.library_dynamic_preparing();
  else if (basisState === 'preparing') status = m.library_rule_preparing();
  else if (basisState === 'unavailable') status = m.library_rule_review_metadata_unavailable();
  else if (incomplete) status = m.library_rule_results_incomplete();
  else if (empty) status = exhausted ? m.library_rule_results_empty() : m.library_rule_results_page_empty();
  else status = m.library_rule_results_ready({ count: page.members.length });
  return (
    <div className="min-w-0 space-y-2 rounded-lg bg-muted/50 p-3" aria-labelledby="saved-rule-results-response">
      <h3 id="saved-rule-results-response" className="font-medium">
        {m.library_rule_results_response_heading()}
      </h3>
      <p role={ready ? 'status' : 'alert'}>{status}</p>
      {page.cursorRestarted ? <p role="status">{m.library_collections_cursor_reset()}</p> : null}
    </div>
  );
}
