import { cn } from '@rezics/ui/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItem } from '@rezics/ui/content-item';
import { useLayoutEffect, useState, useRef, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useCollectionOwnerCurrent } from './collection-owner-current';
import { subjectHref } from '../subject/subject-href';
import { QueryPublicationView } from './saved-query-publication/query-view';
import { publishQueryCollection, readQueryPublication } from './saved-query-publication/query';
import { CollectionMemberDetails } from './collection-member-row';
import { SubjectCover, rowRatio } from './subject-row';
import { displayLibraryTitle } from './title';
import {
  CollectionPublicationReview,
  publicationReview,
  type PublicationReview,
} from './collection-publication-review';
import {
  CollectionPublicationWorkspace,
  type CollectionPublicationWorkspaceMode,
} from './collection-publication-workspace';
import {
  collectionPublicationQuery,
  publicationCandidates,
  publishSelectedCollection,
  type PublicationAddress,
  type PublicationComplete,
  type PublicationInput,
  type PublicationPage,
  type PublicationResult,
  publicationReadWithin,
} from './collection-publication';
import {
  SavedQueryAcceptedMeaning,
  SavedQueryPublishedMembership,
  acceptedMeaningFromPage,
  publishedMembershipFromDto,
  publishedMembershipFromComplete,
  type PublishedMembership,
} from './saved-query-publication';

export type PublicationSubmit = (input: PublicationInput) => Promise<PublicationResult>;
export const COLLECTION_PUBLICATION_WRITE_RESPONSE_MS = 25_000;

type QuantityMessage = (input: { count: string }) => string;

function quantityText(count: number, one: QuantityMessage, other: QuantityMessage) {
  const locale = getLocale();
  const message = new Intl.PluralRules(locale).select(count) === 'one' ? one : other;
  return message({ count: new Intl.NumberFormat(locale).format(count) });
}

function resultText(reason: Extract<PublicationResult, { ok: false }>['reason']) {
  if (reason === 'stale') return m.library_publication_stale();
  if (reason === 'denied') return m.library_publication_denied();
  if (reason === 'closed') return m.platform_closed_heading();
  if (reason === 'unknown') return m.library_publication_unknown();
  return m.library_publication_unavailable();
}

type PublicationViewProps = {
  page: PublicationPage;
  submit: PublicationSubmit;
  onReload?: () => void;
  isCurrent?: () => boolean;
  isOwnerCurrent?: () => boolean;
  canPublish?: () => boolean;
  captureSubmit?: () => PublicationSubmit | null;
  responseTimeoutMs?: number;
  mode?: CollectionPublicationWorkspaceMode;
  modeNavigation?: ReactNode;
  queryAction?: ReactNode;
};

/** Authenticated read identity owns selection; mutation credentials never identify the originating intent. */
export function CollectionPublicationPageView(props: PublicationViewProps) {
  const { page } = props;
  const credential = !!page.viewer?.subject;
  return (
    <PublicationIntentView
      key={JSON.stringify([page.viewer?.subject, page.address.id, page.address.cursor, credential])}
      {...props}
      page={
        credential && (page.source.state !== 'ready' || page.source.page.id === page.address.id)
          ? page
          : { ...page, source: { state: 'unavailable' } }
      }
    />
  );
}

type IntentState = {
  sourceKey: string | null;
  selected: string[];
  confirmed: boolean;
  attempt: {
    token: object;
    input: PublicationInput;
    send: PublicationSubmit;
    sourceKey: string | null;
    review: PublicationReview;
    uncertain: boolean;
  } | null;
  result: PublicationResult | null;
  complete: PublicationComplete | null;
  publishedReview: PublicationReview | null;
  currentPublished: PublishedMembership;
  currentPublishedRevision: number | null;
  busy: boolean;
};

/** A source read is selection context; only a complete native command response is a publication result. */
function PublicationIntentView({
  page,
  submit,
  onReload,
  isCurrent = () => true,
  canPublish = () => !!page.viewer?.csrfToken,
  captureSubmit,
  responseTimeoutMs = COLLECTION_PUBLICATION_WRITE_RESPONSE_MS,
  isOwnerCurrent = isCurrent,
  mode = 'selected',
  modeNavigation,
  queryAction,
}: PublicationViewProps) {
  const source = page.source;
  const ready = source.state === 'ready';
  const candidates = ready ? publicationCandidates(source.page) : [];
  const sourceKey = ready
    ? JSON.stringify([
        source.revision,
        source.page.title,
        source.page.description,
        candidates.map((member) => member.subject!.id),
      ])
    : null;
  const [state, setState] = useState<IntentState>({
    sourceKey,
    selected: [],
    confirmed: false,
    attempt: null,
    result: null,
    complete: null,
    publishedReview: null,
    currentPublished: { state: 'unavailable' },
    currentPublishedRevision: null,
    busy: false,
  });
  // Events and completions share the same synchronous gate, including before React renders again.
  const current = useRef(state);
  const active = useRef(true);
  function update(change: (previous: IntentState) => IntentState, currentOwner = isCurrent) {
    if (!active.current || !currentOwner()) return;
    current.current = change(current.current);
    setState(current.current);
  }
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (!sourceKey || current.current.sourceKey === sourceKey) return;
    update((previous) => ({
      ...previous,
      sourceKey,
      // A new read cannot replace a dispatched command, even when its selected IDs disappear.
      ...(previous.attempt ? {} : { selected: [], confirmed: false, result: null }),
    }));
  }, [sourceKey]);
  const { selected, confirmed, result, complete, publishedReview, busy } = state;
  const currentPagePublished = ready ? publishedMembershipFromDto(source.page) : { state: 'unavailable' as const };
  const currentReadRevision = ready ? source.revision : null;
  const published =
    currentPagePublished.state === 'complete' &&
    (state.currentPublishedRevision === null ||
      (currentReadRevision !== null && currentReadRevision >= state.currentPublishedRevision))
      ? currentPagePublished
      : state.currentPublished;
  const ratio = rowRatio(candidates.map((member) => member.subject));
  // A refusal on a later retry proves nothing about the original dispatch's commit.
  const unknown = state.attempt?.uncertain === true;
  const refused = result?.ok === false && !unknown;
  const locked = busy || unknown || refused;
  const base = `/${getLocale()}/collections/${encodeURIComponent(page.address.id)}`;
  const review = isCurrent()
    ? (state.attempt?.review ?? (ready ? publicationReview(source.page, source.revision, selected) : null))
    : null;

  useLayoutEffect(() => {
    if (source.state !== 'ready' || currentPagePublished.state !== 'complete' || !Number.isSafeInteger(source.revision))
      return;
    update((previous) => {
      const current = previous.currentPublished;
      if (previous.currentPublishedRevision !== null && source.revision < previous.currentPublishedRevision)
        return previous;
      if (
        current.state === 'complete' &&
        current.generation === currentPagePublished.generation &&
        current.itemCount === currentPagePublished.itemCount &&
        previous.currentPublishedRevision === source.revision
      )
        return previous;
      return {
        ...previous,
        currentPublished: currentPagePublished,
        currentPublishedRevision: source.revision,
      };
    });
  }, [ready, source, currentPagePublished]);

  async function publish() {
    const origin = current.current;
    const uncertain = origin.attempt?.uncertain === true;
    if (
      !active.current ||
      !isCurrent() ||
      (!canPublish() && !uncertain) ||
      (!ready && !uncertain) ||
      !origin.confirmed ||
      origin.busy ||
      (origin.result?.ok === false && !uncertain) ||
      (uncertain && !origin.attempt)
    )
      return;
    let input: PublicationInput;
    let review: PublicationReview;
    if (uncertain && origin.attempt) {
      input = origin.attempt.input;
      review = origin.attempt.review;
    } else if (source.state === 'ready') {
      input = {
        collectionId: page.address.id,
        revision: Math.max(origin.complete?.collection.revision ?? 0, source.revision),
        subjectIds: [...origin.selected].sort(),
        idempotencyKey: crypto.randomUUID(),
      };
      review = publicationReview(source.page, input.revision, origin.selected);
    } else {
      return;
    }
    const send = origin.attempt?.send ?? (captureSubmit ? captureSubmit() : submit);
    if (!send) return;
    const capturedAttempt = origin.attempt ?? {
      token: {},
      input,
      send,
      sourceKey: origin.sourceKey,
      review,
      uncertain: false,
    };
    update((previous) => ({
      ...previous,
      busy: true,
      attempt: previous.attempt ?? capturedAttempt,
    }));
    if (!active.current || !isCurrent()) return;
    const settle = (outcome: PublicationResult) => {
      if (!active.current || !isOwnerCurrent()) return;
      update((previous) => {
        if (previous.attempt?.token !== capturedAttempt.token) return previous;
        if (outcome.ok)
          return {
            ...previous,
            result: outcome,
            busy: false,
            complete: outcome,
            publishedReview: capturedAttempt.review,
            ...(previous.currentPublishedRevision === null ||
            previous.currentPublishedRevision <= outcome.collection.revision
              ? {
                  currentPublished: publishedMembershipFromComplete(outcome),
                  currentPublishedRevision: outcome.collection.revision,
                }
              : {}),
            attempt: null,
            confirmed: false,
            selected: previous.sourceKey === capturedAttempt.sourceKey ? previous.selected : [],
          };
        const uncertain = previous.attempt.uncertain || outcome.reason === 'unknown';
        return {
          ...previous,
          result: uncertain ? { ok: false, reason: 'unknown' } : outcome,
          busy: false,
          attempt: { ...capturedAttempt, uncertain },
        };
      }, isOwnerCurrent);
    };
    let timedOut = false;
    const response = Promise.resolve()
      .then(() => capturedAttempt.send(capturedAttempt.input))
      .catch((): PublicationResult => ({ ok: false, reason: 'unknown' }));
    void response.then((outcome) => {
      if (timedOut) settle(outcome);
    });
    const outcome = await publicationReadWithin<{ state: 'response'; value: PublicationResult } | { state: 'timeout' }>(
      response.then((value) => ({ state: 'response' as const, value })),
      responseTimeoutMs,
      { state: 'timeout' as const },
    );
    if (outcome.state === 'timeout') {
      timedOut = true;
      settle({ ok: false, reason: 'unknown' });
    } else {
      settle(outcome.value);
    }
    // The response race never aborts native work. A later result can settle only this captured attempt.
  }

  function reload() {
    const previous = current.current;
    if (!active.current || !isCurrent() || previous.busy) return;
    // Recover an unavailable read without turning an uncertain write into a fresh selection.
    if (!previous.attempt?.uncertain)
      update((value) => ({ ...value, selected: [], confirmed: false, attempt: null, result: null }));
    onReload?.();
  }

  const feedback = (
    <>
      {result?.ok === false ? <p role="alert">{resultText(unknown ? 'unknown' : result.reason)}</p> : null}
      {busy ? <p role="status">{m.library_publication_pending()}</p> : null}
    </>
  );

  const selection = ready ? (
    <>
      <p className="max-w-prose text-sm text-muted-foreground">{m.library_publication_choose()}</p>
      {candidates.length ? (
        <ul className="min-w-0 space-y-3" data-publication-candidates>
          {candidates.map((member) => {
            const id = member.subject!.id;
            const checked = selected.includes(id);
            const title = displayLibraryTitle(member.subject!.label, getLocale());
            return (
              <ContentItem
                key={id}
                className={`min-w-0 rounded-xl border p-3 [overflow-wrap:anywhere] ${checked ? 'border-primary/50 bg-primary/5' : 'border-border bg-card'}`}
                title={title.text}
                {...(title.lang ? { titleLang: title.lang } : {})}
                headingLevel={3}
                href={subjectHref({ id, label: title.text }, getLocale()).href}
                visual={<SubjectCover subject={member.subject} ratio={ratio} />}
                metadata={<CollectionMemberDetails member={member} listPresentations={source.page.listPresentations} />}
                trailing={
                  <label className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg focus-within:ring-2 focus-within:ring-ring/30">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 cursor-pointer accent-primary"
                      checked={checked}
                      aria-label={m.library_publication_select({
                        title:
                          typeof member.subject!.label === 'string'
                            ? member.subject!.label
                            : member.subject!.label.value,
                      })}
                      disabled={locked || (!checked && selected.length >= 100)}
                      onChange={() => {
                        if (!isCurrent()) return;
                        update((previous) => {
                          if (previous.busy || previous.attempt) return previous;
                          const selected = previous.selected.includes(id)
                            ? previous.selected.filter((value) => value !== id)
                            : previous.selected.length < 100
                              ? [...previous.selected, id]
                              : previous.selected;
                          return { ...previous, selected, confirmed: false, result: null };
                        });
                      }}
                    />
                  </label>
                }
              />
            );
          })}
        </ul>
      ) : (
        <p role="status">{m.library_publication_no_disclosed()}</p>
      )}
    </>
  ) : undefined;

  const reviewContent = ready ? (
    <>
      <p id="publication-count" className="font-medium" role="status">
        {quantityText(selected.length, m.library_publication_count_one, m.library_publication_count)}
      </p>
      <p id="publication-bounds" className="max-w-prose text-sm text-muted-foreground">
        {m.library_publication_page_only()}
      </p>
      <p id="publication-replacement" className="max-w-prose text-sm">
        {m.library_publication_previous()}
      </p>
      <SavedQueryAcceptedMeaning meaning={acceptedMeaningFromPage(source.page, source.revision)} />
      {review ? <CollectionPublicationReview review={review} /> : null}
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary focus-within:ring-2 focus-within:ring-ring/30">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-primary"
          checked={confirmed}
          disabled={locked}
          aria-describedby="publication-count publication-bounds publication-replacement publication-privacy"
          onChange={(event) => {
            if (!isCurrent()) return;
            const confirmed = event.target.checked;
            update((previous) => (previous.busy || previous.attempt ? previous : { ...previous, confirmed }));
          }}
        />
        <span className="min-w-0 break-words">
          {selected.length
            ? quantityText(selected.length, m.library_publication_confirm_one, m.library_publication_confirm)
            : m.library_publication_confirm_empty()}
        </span>
      </label>
      <p id="publication-privacy" className="max-w-prose text-sm text-muted-foreground">
        {m.library_publication_privacy()}
      </p>
      {feedback}
      <div className="flex min-w-0 flex-wrap gap-3 border-t border-border pt-4">
        <Button
          type="button"
          className="h-auto min-h-7 w-full max-w-full whitespace-normal text-start"
          aria-describedby="publication-bounds publication-replacement publication-privacy"
          disabled={!confirmed || busy || refused || (unknown ? !state.attempt || !isOwnerCurrent() : !canPublish())}
          onClick={() => void publish()}
        >
          {unknown ? m.library_publication_retry() : m.library_publication_publish()}
        </Button>
        {onReload && !busy ? (
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-7 max-w-full whitespace-normal text-start"
            onClick={reload}
          >
            {m.library_collection_reload()}
          </Button>
        ) : null}
      </div>
    </>
  ) : undefined;

  const unavailable = !ready ? (
    <div className="space-y-3">
      <p role="alert">
        {source.state === 'denied'
          ? m.library_publication_denied()
          : source.state === 'unsupported'
            ? m.library_publication_unsupported()
            : source.state === 'preparing'
              ? m.library_dynamic_preparing()
              : m.library_publication_unavailable()}
      </p>
      <p className="max-w-prose text-sm text-muted-foreground">{m.library_publication_previous()}</p>
      {unknown && review ? <CollectionPublicationReview review={review} /> : null}
      {feedback}
      <Button
        type="button"
        className="h-auto min-h-7 max-w-full whitespace-normal text-start"
        disabled={!unknown || busy || !isOwnerCurrent()}
        onClick={() => void publish()}
      >
        {unknown ? m.library_publication_retry() : m.library_publication_publish()}
      </Button>
      {onReload && !busy ? (
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-7 max-w-full whitespace-normal text-start"
          onClick={reload}
        >
          {m.library_collection_reload()}
        </Button>
      ) : null}
    </div>
  ) : undefined;

  const continuation = ready && source.page.next && !locked ? (
    <div className="space-y-1" data-publication-continuation>
      <p className="text-sm text-muted-foreground">{m.library_publication_more_pages()}</p>
      <a
        className={cn(buttonVariants({ variant: 'link' }), 'h-auto min-h-7 max-w-full whitespace-normal')}
        href={`${base}/publish?${new URLSearchParams({ cursor: source.page.next })}`}
      >
        {m.library_publication_next()}
      </a>
    </div>
  ) : undefined;

  const sourceIdentity = ready ? (
    <div className="min-w-0 space-y-2" data-publication-source>
      <p className="text-lg font-medium [overflow-wrap:anywhere]">{source.page.title}</p>
      {mode === 'query' ? (
        <SavedQueryAcceptedMeaning meaning={acceptedMeaningFromPage(source.page, source.revision)} />
      ) : null}
    </div>
  ) : null;

  const resultContent = (
    <>
      <SavedQueryPublishedMembership published={published} />
      {complete ? (
        <section className="space-y-2 border-t border-border pt-4" aria-label={m.library_publication_output()}>
          <h2 className="text-lg font-semibold">{m.library_publication_output()}</h2>
          <p role="status">
            {quantityText(
              complete.publication.itemCount,
              m.library_publication_complete_one,
              m.library_publication_complete,
            )}
          </p>
          <a className={cn(buttonVariants({ variant: 'link' }), 'h-auto min-h-7 max-w-full whitespace-normal')} href={base}>
            {m.library_publication_view()}
          </a>
          {publishedReview ? (
            <div className="space-y-2">
              <p className="font-medium">{m.library_publication_output_review()}</p>
              <CollectionPublicationReview review={publishedReview} />
            </div>
          ) : null}
        </section>
      ) : null}
      {mode === 'query' && (state.attempt || result?.ok === false) ? (
        <section className="space-y-3 border-t border-border pt-4" aria-labelledby="selected-attempt-review">
          <h2 id="selected-attempt-review" className="text-lg font-semibold">
            {m.collection_workbench_review()}
          </h2>
          <p className="font-medium" role="status">
            {quantityText(
              state.attempt?.input.subjectIds.length ?? selected.length,
              m.library_publication_count_one,
              m.library_publication_count,
            )}
          </p>
          <p className="max-w-prose text-sm">{m.library_publication_previous()}</p>
          {state.attempt ? <CollectionPublicationReview review={state.attempt.review} /> : null}
          {feedback}
          {unknown ? (
            <Button
              type="button"
              className="h-auto min-h-7 max-w-full whitespace-normal text-start"
              disabled={busy || !isOwnerCurrent()}
              onClick={() => void publish()}
            >
              {m.library_publication_retry()}
            </Button>
          ) : null}
          {onReload && !busy ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-7 max-w-full whitespace-normal text-start"
              onClick={reload}
            >
              {m.library_collection_reload()}
            </Button>
          ) : null}
        </section>
      ) : null}
    </>
  );

  return (
    <CollectionPublicationWorkspace
      mode={mode}
      modeNavigation={modeNavigation}
      backLink={
        mode === 'selected' ? (
          <a className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'h-auto min-h-6 max-w-full whitespace-normal')} href={base}>
            {m.library_publication_back()}
          </a>
        ) : undefined
      }
      sourceIdentity={sourceIdentity}
      help={mode === 'selected' ? m.collection_workbench_publication_help() : undefined}
      busy={busy}
      sourceKey={sourceKey}
      unavailable={unavailable}
      selection={selection}
      review={reviewContent}
      queryAction={queryAction}
      continuation={continuation}
      result={resultContent}
      details={
        ready ? (
          <details className="max-w-prose text-sm text-muted-foreground" data-publication-details>
            <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {m.library_publication_details()}
            </summary>
            <div className="space-y-2 pt-2">
              <p>{m.library_publication_description()}</p>
              <p>{m.library_publication_canonical()}</p>
            </div>
          </details>
        ) : undefined
      }
    />
  );
}

export function CollectionPublicationPage({ address }: { address: PublicationAddress }) {
  const owner = useCollectionOwnerCurrent(JSON.stringify(['publication', address.id, address.cursor ?? null]));
  if (!owner.subject)
    return (
      <CollectionPublicationPageView
        page={{ viewer: null, address, source: { state: 'denied' } }}
        submit={async () => ({ ok: false, reason: 'denied' })}
      />
    );
  return (
    <CurrentPublicationPage
      key={owner.generation}
      subject={owner.subject}
      csrfToken={owner.csrfToken}
      address={address}
      owner={owner}
    />
  );
}

function CurrentPublicationPage({
  subject,
  csrfToken,
  address,
  owner,
}: {
  subject: string;
  csrfToken: string;
  address: PublicationAddress;
  owner: ReturnType<typeof useCollectionOwnerCurrent>;
}) {
  const client = useQueryClient();
  const [wholeQuery, setWholeQuery] = useState(false);
  const viewer = { subject, csrfToken };
  const started = useRef(new Set<string>());
  const readIdentity = JSON.stringify([subject, csrfToken, address.id, address.cursor, owner.lifetime]);
  const options = collectionPublicationQuery(viewer, address, () => {
    if (!owner.isCurrent()) return false;
    started.current.add(readIdentity);
    return true;
  });
  const query = useQuery({
    ...options,
    // A returning viewer/address cannot join a still-pending read or reuse its old cached result.
    queryKey: [...options.queryKey, owner.lifetime],
    // Admission churn may suspend a read, but never automatically replays a failed read.
    enabled: owner.isCurrent() && !started.current.has(readIdentity),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  function canPublish(mode: 'selected' | 'query' = 'selected') {
    const csrf = owner.credential();
    if (!csrf) return false;
    // Consult the actual cache before a replacement render commits, including a rotated credential's read.
    const state = client.getQueryState<PublicationPage>([
      ...collectionPublicationQuery({ subject, csrfToken: csrf }, address).queryKey,
      owner.lifetime,
    ]);
    const current = state?.data;
    return (
      state?.status === 'success' &&
      state.fetchStatus === 'idle' &&
      current === query.data &&
      current?.viewer?.subject === subject &&
      current.address.id === address.id &&
      current.address.cursor === address.cursor &&
      ((mode === 'query' &&
        current.builtin?.id === address.id &&
        owner.operationCurrent('collection.update', true)) ||
        (current.source.state === 'ready' &&
          current.source.page.id === address.id &&
          current.source.page.curatorAccountId === subject &&
          current.source.page.builtinKind === undefined))
    );
  }
  const data = query.data;
  const matches =
    owner.isCurrent() &&
    data?.viewer?.subject === subject &&
    data.address.id === address.id &&
    data.address.cursor === address.cursor &&
    (data.source.state !== 'ready' ||
      (data.source.page.id === address.id &&
        data.source.page.curatorAccountId === subject &&
        data.source.page.builtinKind === undefined));
  const page: PublicationPage =
    query.isSuccess && !query.isFetching && matches
      ? data
      : {
          viewer,
          address,
          source: {
            state: owner.isCurrent() && !query.isFetching && data?.source.state === 'denied' ? 'denied' : 'unavailable',
          },
        };
  const mode: CollectionPublicationWorkspaceMode =
    page.builtin || (wholeQuery && page.source.state === 'ready') ? 'query' : 'selected';
  const querySource =
    page.builtin ??
    (mode === 'query' && page.source.state === 'ready'
      ? { revision: page.source.revision, visibility: page.source.page.visibility }
      : null);
  const modeNavigation = page.source.state === 'ready' ? (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2"
      role="group"
      aria-label={m.library_publication_heading()}
      data-publication-mode-navigation
    >
      <Button
        type="button"
        className="h-auto min-h-7 max-w-full whitespace-normal text-start"
        variant={wholeQuery ? 'default' : 'outline'}
        aria-pressed={wholeQuery}
        onClick={() => setWholeQuery(true)}
      >
        {m.library_query_publication_heading()}
      </Button>
      <Button
        type="button"
        className="h-auto min-h-7 max-w-full whitespace-normal text-start"
        variant={!wholeQuery ? 'default' : 'outline'}
        aria-pressed={!wholeQuery}
        onClick={() => setWholeQuery(false)}
      >
        {m.library_publication_choose()}
      </Button>
    </div>
  ) : undefined;
  return (
    <>
      {query.isFetching ? (
        <div role="status" className="p-6">
          {m.library_publication_loading()}
        </div>
      ) : null}
      <CollectionPublicationPageView
        page={page}
        mode={mode}
        modeNavigation={modeNavigation}
        queryAction={
          querySource ? (
            <QueryPublicationView
              key={JSON.stringify([subject, address.id, owner.lifetime])}
              subject={subject}
              collectionId={address.id}
              revision={querySource.revision}
              visibility={querySource.visibility}
              isCurrent={owner.isOwnerCurrent}
              canBegin={() => canPublish('query')}
              capture={() => {
                const csrf = owner.credential();
                if (!csrf || !owner.isCurrent()) return null;
                return {
                  begin: (input) => publishQueryCollection({ data: input, headers: { 'X-CSRF-Token': csrf } }),
                  read: (input) => readQueryPublication({ data: input, headers: { 'X-CSRF-Token': csrf } }),
                };
              }}
            />
          ) : undefined
        }
        isCurrent={owner.isCurrent}
        isOwnerCurrent={owner.isOwnerCurrent}
        canPublish={canPublish}
        captureSubmit={() => {
          const csrf = owner.credential();
          if (!csrf || !canPublish()) return null;
          const send = publishSelectedCollection;
          return (input) => send({ data: input, headers: { 'X-CSRF-Token': csrf } });
        }}
        submit={async (input) => {
          const csrf = owner.credential();
          if (!csrf || !canPublish()) return { ok: false, reason: 'denied' };
          // Preserve the real outcome of a dispatched native write. Its view fences settlement by owner identity.
          return publishSelectedCollection({ data: input, headers: { 'X-CSRF-Token': csrf } });
        }}
        {...(query.isFetching
          ? {}
          : {
              onReload: () => {
                if (
                  owner.isCurrent() &&
                  client.getQueryState([...options.queryKey, owner.lifetime])?.fetchStatus !== 'fetching'
                )
                  void query.refetch().catch(() => undefined);
              },
            })}
      />
    </>
  );
}
