import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItem } from '@rezics/ui/content-item';
import { useLayoutEffect, useState, useRef } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useCollectionOwnerCurrent } from './collection-owner-current';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import { CollectionMemberDetails } from './collection-member-row';
import { SubjectCover, rowRatio } from './subject-row';
import { displayLibraryTitle } from './title';
import {
  CollectionPublicationReview,
  publicationReview,
  type PublicationReview,
} from './collection-publication-review';
import {
  collectionPublicationQuery,
  publicationCandidates,
  publishSelectedCollection,
  type PublicationAddress,
  type PublicationComplete,
  type PublicationInput,
  type PublicationPage,
  type PublicationResult,
} from './collection-publication';
import {
  SavedQueryAcceptedMeaning,
  SavedQueryPublishedMembership,
  acceptedMeaningFromPage,
  publishedMembership,
} from './saved-query-publication';

export type PublicationSubmit = (input: PublicationInput) => Promise<PublicationResult>;

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
    input: PublicationInput;
    send: PublicationSubmit;
    sourceKey: string | null;
    review: PublicationReview;
    uncertain: boolean;
  } | null;
  result: PublicationResult | null;
  complete: PublicationComplete | null;
  publishedReview: PublicationReview | null;
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
  isOwnerCurrent = isCurrent,
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
  const published = publishedMembership(complete, ready ? source.page : null);
  const ratio = rowRatio(candidates.map((member) => member.subject));
  // A refusal on a later retry proves nothing about the original dispatch's commit.
  const unknown = state.attempt?.uncertain === true;
  const refused = result?.ok === false && !unknown;
  const locked = busy || unknown || refused;
  const base = `/${getLocale()}/collections/${encodeURIComponent(page.address.id)}`;
  const review = isCurrent()
    ? (state.attempt?.review ?? (ready ? publicationReview(source.page, source.revision, selected) : null))
    : null;

  async function publish() {
    const origin = current.current;
    const uncertain = origin.attempt?.uncertain === true;
    if (
      !active.current ||
      !isCurrent() ||
      !canPublish() ||
      !ready ||
      !origin.confirmed ||
      origin.busy ||
      (origin.result?.ok === false && !uncertain) ||
      (uncertain && !origin.attempt)
    )
      return;
    const input =
      uncertain && origin.attempt
        ? origin.attempt.input
        : {
            collectionId: page.address.id,
            revision: Math.max(origin.complete?.collection.revision ?? 0, source.revision),
            subjectIds: [...origin.selected],
            idempotencyKey: crypto.randomUUID(),
          };
    const send = origin.attempt?.send ?? (captureSubmit ? captureSubmit() : submit);
    if (!send) return;
    update((previous) => ({
      ...previous,
      busy: true,
      attempt: previous.attempt ?? {
        input,
        send,
        sourceKey: origin.sourceKey,
        review: publicationReview(source.page, input.revision, origin.selected),
        uncertain: false,
      },
    }));
    let outcome: PublicationResult;
    try {
      if (!active.current || !isCurrent()) return;
      outcome = await send(input);
    } catch {
      outcome = { ok: false, reason: 'unknown' };
    }
    if (!active.current || !isOwnerCurrent()) return;
    update(
      (previous) => ({
        ...previous,
        result: outcome,
        busy: false,
        attempt: previous.attempt && {
          ...previous.attempt,
          uncertain: previous.attempt.uncertain || (!outcome.ok && outcome.reason === 'unknown'),
        },
        ...(outcome.ok
          ? {
              complete: outcome,
              publishedReview: previous.attempt?.review ?? previous.publishedReview,
              attempt: null,
              confirmed: false,
              selected: previous.sourceKey === previous.attempt?.sourceKey ? previous.selected : [],
            }
          : {}),
      }),
      isOwnerCurrent,
    );
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

  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 text-foreground sm:py-8" aria-busy={busy}>
      <header className="space-y-3">
        <a className="text-primary underline" href={base}>
          {m.library_publication_back()}
        </a>
        <PageHeading>{m.library_publication_heading()}</PageHeading>
        {ready ? <p className="text-lg font-medium break-words">{source.page.title}</p> : null}
      </header>
      {!ready ? (
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
          <SavedQueryPublishedMembership published={published} review={publishedReview} />
          {unknown && review ? <CollectionPublicationReview review={review} /> : null}
          {feedback}
          <Button type="button" disabled>
            {m.library_publication_publish()}
          </Button>
          {onReload && !busy ? (
            <Button type="button" variant="outline" onClick={reload}>
              {m.library_collection_reload()}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <section className="space-y-4" aria-labelledby="publication-selection" aria-busy={busy} data-publication-current>
            <h2 id="publication-selection" className="text-xl font-semibold">
              {m.library_publication_current()}
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">{m.library_publication_choose()}</p>
            {candidates.length ? (
              <ul className="space-y-4">
                {candidates.map((member) => {
                  const id = member.subject!.id;
                  const checked = selected.includes(id);
                  const title = displayLibraryTitle(member.subject!.label, getLocale());
                  return (
                    <ContentItem
                      key={id}
                      title={title.text}
                      {...(title.lang ? { titleLang: title.lang } : {})}
                      headingLevel={3}
                      href={subjectHref({ id, label: title.text }, getLocale()).href}
                      visual={<SubjectCover subject={member.subject} ratio={ratio} />}
                      metadata={
                        <CollectionMemberDetails member={member} listPresentations={source.page.listPresentations} />
                      }
                      trailing={
                        <input
                          type="checkbox"
                          className="size-5 shrink-0 accent-primary"
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
                      }
                    />
                  );
                })}
              </ul>
            ) : (
              <p role="status">{m.library_publication_no_disclosed()}</p>
            )}
            <div
              role="group"
              aria-labelledby="publication-count"
              className="min-w-0 space-y-3 rounded-xl bg-muted/50 p-4 sm:p-5"
              data-publication-confirmation
            >
              <p id="publication-count" className="font-medium" role="status">
                {quantityText(selected.length, m.library_publication_count_one, m.library_publication_count)}
              </p>
              <p id="publication-bounds" className="max-w-prose text-sm text-muted-foreground">
                {m.library_publication_page_only()}
              </p>
              <p id="publication-replacement" className="max-w-prose text-sm">
                {m.library_publication_previous()}
              </p>
              <SavedQueryAcceptedMeaning
                meaning={ready ? acceptedMeaningFromPage(source.page, source.revision) : null}
              />
              {review ? <CollectionPublicationReview review={review} /> : null}
              <label className="flex min-h-11 items-start gap-3 py-2">
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0 accent-primary"
                  checked={confirmed}
                  disabled={locked}
                  aria-describedby="publication-bounds publication-replacement publication-privacy"
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
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  className="h-auto min-h-11 max-w-full whitespace-normal text-start"
                  aria-describedby="publication-bounds publication-replacement publication-privacy"
                  disabled={!confirmed || busy || refused || !canPublish()}
                  onClick={() => void publish()}
                >
                  {unknown ? m.library_publication_retry() : m.library_publication_publish()}
                </Button>
                {onReload && !busy && !unknown ? (
                  <Button type="button" variant="outline" onClick={reload}>
                    {m.library_collection_reload()}
                  </Button>
                ) : null}
              </div>
            </div>
          </section>
          <SavedQueryPublishedMembership published={published} review={publishedReview} />
          {source.page.next && !locked ? (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{m.library_publication_more_pages()}</p>
              <a
                className="inline-flex min-h-11 items-center text-primary underline"
                href={`${base}/publish?${new URLSearchParams({ cursor: source.page.next })}`}
              >
                {m.library_publication_next()}
              </a>
            </div>
          ) : null}
        </>
      )}
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
          <a className="inline-flex min-h-11 items-center text-primary underline" href={base}>
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
      {ready ? (
        <details className="max-w-prose text-sm text-muted-foreground" data-publication-details>
          <summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.library_publication_details()}
          </summary>
          <div className="space-y-2 pt-2">
            <p>{m.library_publication_description()}</p>
            <p>{m.library_publication_canonical()}</p>
          </div>
        </details>
      ) : null}
    </article>
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
  function canPublish() {
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
      current.source.state === 'ready' &&
      current.source.page.id === address.id &&
      current.source.page.curatorAccountId === subject &&
      current.source.page.builtinKind === undefined
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
  return (
    <>
      {query.isFetching ? (
        <div role="status" className="p-6">
          {m.library_publication_loading()}
        </div>
      ) : null}
      <CollectionPublicationPageView
        page={page}
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
