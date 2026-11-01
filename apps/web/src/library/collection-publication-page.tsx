import { useQuery } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { ListRow } from '@rezics/ui/list-row';
import { useLayoutEffect, useState, useRef } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { PageHeading } from '../shell/page-heading';
import { CollectionMemberDetails } from './collection-member-row';
import { SubjectIdentity, rowRatio } from './subject-row';
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
};

/** Credentials authorize a fresh source read; their strings do not identify the originating intent. */
export function CollectionPublicationPageView(props: PublicationViewProps) {
  const { page } = props;
  const credential = !!page.viewer?.subject && !!page.viewer.csrfToken;
  const authorityLost = page.source.state === 'denied' || page.source.state === 'unsupported';
  return (
    <PublicationIntentView
      key={JSON.stringify([page.viewer?.subject, page.address.id, page.address.cursor, credential, authorityLost])}
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
  attempt: { input: PublicationInput; sourceKey: string | null } | null;
  result: PublicationResult | null;
  complete: PublicationComplete | null;
  busy: boolean;
};

/** A source read is selection context; only a complete native command response is a publication result. */
function PublicationIntentView({ page, submit, onReload }: PublicationViewProps) {
  const source = page.source;
  const ready = source.state === 'ready';
  const candidates = ready ? publicationCandidates(source.page) : [];
  const sourceKey = ready ? JSON.stringify([source.revision, candidates.map((member) => member.subject!.id)]) : null;
  const [state, setState] = useState<IntentState>({
    sourceKey,
    selected: [],
    confirmed: false,
    attempt: null,
    result: null,
    complete: null,
    busy: false,
  });
  // Events and completions share the same synchronous gate, including before React renders again.
  const current = useRef(state);
  const active = useRef(true);
  function update(change: (previous: IntentState) => IntentState) {
    if (!active.current) return;
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
  const { selected, confirmed, result, complete, busy } = state;
  const ratio = rowRatio(candidates.map((member) => member.subject));
  const unknown = result?.ok === false && result.reason === 'unknown';
  const refused = result?.ok === false && !unknown;
  const locked = busy || unknown || refused;
  const base = `/${getLocale()}/collections/${encodeURIComponent(page.address.id)}`;

  async function publish() {
    const origin = current.current;
    const uncertain = origin.result?.ok === false && origin.result.reason === 'unknown';
    if (
      !active.current ||
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
    update((previous) => ({
      ...previous,
      busy: true,
      attempt: previous.attempt ?? { input, sourceKey: origin.sourceKey },
    }));
    let outcome: PublicationResult;
    try {
      outcome = await submit(input);
    } catch {
      outcome = { ok: false, reason: 'unknown' };
    }
    update((previous) => ({
      ...previous,
      result: outcome,
      busy: false,
      ...(outcome.ok
        ? {
            complete: outcome,
            attempt: null,
            confirmed: false,
            selected: previous.sourceKey === previous.attempt?.sourceKey ? previous.selected : [],
          }
        : {}),
    }));
  }

  function reload() {
    const previous = current.current;
    if (!active.current || previous.busy) return;
    // Recover an unavailable read without turning an uncertain write into a fresh selection.
    if (!(previous.result?.ok === false && previous.result.reason === 'unknown'))
      update((value) => ({ ...value, selected: [], confirmed: false, attempt: null, result: null }));
    onReload?.();
  }

  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 text-foreground sm:py-8" aria-busy={busy}>
      <header className="space-y-3">
        <a className="text-primary underline" href={base}>
          {m.library_publication_back()}
        </a>
        <PageHeading>{m.library_publication_heading()}</PageHeading>
        {ready ? <p className="text-lg font-medium break-words">{source.page.title}</p> : null}
        <p className="max-w-prose text-muted-foreground">{m.library_publication_description()}</p>
      </header>
      <section
        className="space-y-3 rounded-xl border border-border bg-card p-4"
        aria-label={m.library_publication_output()}
      >
        <h2 className="text-lg font-semibold">{m.library_publication_output()}</h2>
        {complete ? (
          <p role="status">
            {quantityText(
              complete.publication.itemCount,
              m.library_publication_complete_one,
              m.library_publication_complete,
            )}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">{m.library_publication_previous()}</p>
        <a className="inline-flex min-h-10 items-center text-primary underline" href={base}>
          {m.library_publication_view()}
        </a>
      </section>
      {result?.ok === false ? <p role="alert">{resultText(result.reason)}</p> : null}
      {!ready ? (
        <div role="alert" className="space-y-3">
          <p>
            {source.state === 'denied'
              ? m.library_publication_denied()
              : source.state === 'unsupported'
                ? m.library_publication_unsupported()
                : source.state === 'preparing'
                  ? m.library_dynamic_preparing()
                  : m.library_publication_unavailable()}
          </p>
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
          <section className="space-y-4" aria-labelledby="publication-selection" aria-busy={busy}>
            <h2 id="publication-selection" className="text-xl font-semibold">
              {m.library_publication_choose()}
            </h2>
            <p className="text-sm text-muted-foreground">{m.library_publication_page_only()}</p>
            {candidates.length ? (
              <ul className="space-y-4">
                {candidates.map((member) => {
                  const id = member.subject!.id;
                  const checked = selected.includes(id);
                  return (
                    <ListRow key={id} className="flex items-center gap-3 p-3">
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
                      <div className="min-w-0 flex-1 space-y-2">
                        <SubjectIdentity subject={member.subject} ratio={ratio} />
                        <CollectionMemberDetails member={member} listPresentations={source.page.listPresentations} />
                      </div>
                    </ListRow>
                  );
                })}
              </ul>
            ) : (
              <p role="status">{m.library_publication_no_disclosed()}</p>
            )}
            {source.page.next ? <p className="text-sm">{m.library_publication_more_pages()}</p> : null}
            <p className="font-medium" role="status">
              {quantityText(selected.length, m.library_publication_count_one, m.library_publication_count)}
            </p>
            <p className="text-sm text-muted-foreground">{m.library_publication_canonical()}</p>
            <label className="flex min-h-11 items-start gap-3 rounded-xl bg-muted p-4">
              <input
                type="checkbox"
                className="mt-1 size-5 shrink-0 accent-primary"
                checked={confirmed}
                disabled={locked}
                onChange={(event) => {
                  const confirmed = event.target.checked;
                  update((previous) => (previous.busy || previous.attempt ? previous : { ...previous, confirmed }));
                }}
              />
              <span>
                {selected.length
                  ? quantityText(selected.length, m.library_publication_confirm_one, m.library_publication_confirm)
                  : m.library_publication_confirm_empty()}
              </span>
            </label>
            <p className="max-w-prose text-sm text-muted-foreground">{m.library_publication_privacy()}</p>
            <div className="flex flex-wrap gap-3">
              <Button type="button" disabled={!confirmed || busy || refused} onClick={() => void publish()}>
                {unknown ? m.library_publication_retry() : m.library_publication_publish()}
              </Button>
              {onReload && !busy && !unknown ? (
                <Button type="button" variant="outline" onClick={reload}>
                  {m.library_collection_reload()}
                </Button>
              ) : null}
            </div>
          </section>
          {source.page.next && !locked ? (
            <a
              className="inline-flex min-h-11 items-center text-primary underline"
              href={`${base}/publish?${new URLSearchParams({ cursor: source.page.next })}`}
            >
              {m.library_publication_next()}
            </a>
          ) : null}
        </>
      )}
    </article>
  );
}

export function CollectionPublicationPage({ address }: { address: PublicationAddress }) {
  const session = useSession();
  if (session.state === 'unknown')
    return (
      <div role="status" className="p-6">
        {m.library_publication_loading()}
      </div>
    );
  if (session.state !== 'signed-in' || !session.subject || !session.csrfToken)
    return (
      <CollectionPublicationPageView
        page={{ viewer: null, address, source: { state: 'denied' } }}
        submit={async () => ({ ok: false, reason: 'denied' })}
      />
    );
  return (
    <CurrentPublicationPage
      key={JSON.stringify([session.subject, address.id, address.cursor])}
      subject={session.subject}
      csrfToken={session.csrfToken}
      id={address.id}
      {...(address.cursor === undefined ? {} : { cursor: address.cursor })}
    />
  );
}

function CurrentPublicationPage({
  subject,
  csrfToken,
  id,
  cursor,
}: {
  subject: string;
  csrfToken: string;
  id: string;
  cursor?: string;
}) {
  const viewer = { subject, csrfToken };
  const address = { id, ...(cursor === undefined ? {} : { cursor }) };
  const query = useQuery({
    ...collectionPublicationQuery(viewer, address),
    enabled: true,
    // A credential's previously cached source cannot authorize its replacement lifetime.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const data = query.data;
  const matches =
    data?.viewer?.subject === subject &&
    data.viewer.csrfToken === csrfToken &&
    data.address.id === id &&
    data.address.cursor === cursor;
  const page: PublicationPage =
    !query.isFetching && !query.isError && matches ? data : { viewer, address, source: { state: 'unavailable' } };
  return (
    <>
      {query.isFetching ? (
        <div role="status" className="p-6">
          {m.library_publication_loading()}
        </div>
      ) : null}
      <CollectionPublicationPageView
        page={page}
        submit={(input) => publishSelectedCollection({ data: input, headers: { 'X-CSRF-Token': csrfToken } })}
        {...(query.isFetching
          ? {}
          : {
              onReload: () => {
                void query.refetch().catch(() => undefined);
              },
            })}
      />
    </>
  );
}
