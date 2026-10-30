import { useQuery } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { ListRow } from '@rezics/ui/list-row';
import { useState, useRef } from 'react';
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

function resultText(reason: Extract<PublicationResult, { ok: false }>['reason']) {
  if (reason === 'stale') return m.library_publication_stale();
  if (reason === 'denied') return m.library_publication_denied();
  if (reason === 'closed') return m.platform_closed_heading();
  if (reason === 'unknown') return m.library_publication_unknown();
  return m.library_publication_unavailable();
}

/** A source read is selection context; only a complete native command response is a publication result. */
export function CollectionPublicationPageView({
  page,
  submit,
  onReload,
}: {
  page: PublicationPage;
  submit: PublicationSubmit;
  onReload?: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<PublicationInput | null>(null);
  const [result, setResult] = useState<PublicationResult | null>(null);
  const [complete, setComplete] = useState<PublicationComplete | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const source = page.source;
  const ready = source.state === 'ready';
  const candidates = ready ? publicationCandidates(source.page) : [];
  const ratio = rowRatio(candidates.map((member) => member.subject));
  const unknown = result?.ok === false && result.reason === 'unknown';
  const refused = result?.ok === false && !unknown;
  const locked = busy || unknown || refused;
  const count = new Intl.NumberFormat(getLocale()).format(selected.length);
  const base = `/${getLocale()}/collections/${encodeURIComponent(page.address.id)}`;

  async function publish() {
    if (!ready || !confirmed || sending.current || refused || (unknown && !attempt)) return;
    const input =
      unknown && attempt
        ? attempt
        : {
            collectionId: page.address.id,
            revision: complete?.collection.revision ?? source.revision,
            subjectIds: [...selected],
            idempotencyKey: crypto.randomUUID(),
          };
    sending.current = true;
    setBusy(true);
    setAttempt(input);
    let outcome: PublicationResult;
    try {
      outcome = await submit(input);
    } catch {
      outcome = { ok: false, reason: 'unknown' };
    }
    setResult(outcome);
    if (outcome.ok) {
      setComplete(outcome);
      setAttempt(null);
      setConfirmed(false);
    }
    sending.current = false;
    setBusy(false);
  }

  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 text-foreground sm:py-8">
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
            {m.library_publication_complete({
              count: new Intl.NumberFormat(getLocale()).format(complete.publication.itemCount),
            })}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">{m.library_publication_previous()}</p>
        <a className="inline-flex min-h-10 items-center text-primary underline" href={base}>
          {m.library_publication_view()}
        </a>
      </section>
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
          {onReload ? (
            <Button type="button" variant="outline" onClick={onReload}>
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
                          setSelected((current) =>
                            checked ? current.filter((value) => value !== id) : [...current, id],
                          );
                          setConfirmed(false);
                          setResult(null);
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
              {m.library_publication_count({ count })}
            </p>
            <p className="text-sm text-muted-foreground">{m.library_publication_canonical()}</p>
            <label className="flex min-h-11 items-start gap-3 rounded-xl bg-muted p-4">
              <input
                type="checkbox"
                className="mt-1 size-5 shrink-0 accent-primary"
                checked={confirmed}
                disabled={locked}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                {selected.length ? m.library_publication_confirm({ count }) : m.library_publication_confirm_empty()}
              </span>
            </label>
            <p className="max-w-prose text-sm text-muted-foreground">{m.library_publication_privacy()}</p>
            {result?.ok === false ? <p role="alert">{resultText(result.reason)}</p> : null}
            <div className="flex flex-wrap gap-3">
              <Button type="button" disabled={!confirmed || busy || refused} onClick={() => void publish()}>
                {unknown ? m.library_publication_retry() : m.library_publication_publish()}
              </Button>
              {onReload && !busy && !unknown ? (
                <Button type="button" variant="outline" onClick={onReload}>
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
  const viewer = { subject: session.subject ?? '', csrfToken: session.csrfToken ?? '' };
  const query = useQuery({
    ...collectionPublicationQuery(viewer, address),
    enabled: session.state === 'signed-in' && !!viewer.subject && !!viewer.csrfToken,
  });
  const [version, setVersion] = useState(0);
  const page: PublicationPage = query.data ?? { viewer: null, address, source: { state: 'unavailable' } };
  if (session.state === 'unknown' || (session.state === 'signed-in' && query.isFetching))
    return (
      <div role="status" className="p-6">
        {m.library_publication_loading()}
      </div>
    );
  return (
    <CollectionPublicationPageView
      key={`${viewer.subject}:${viewer.csrfToken}:${address.id}:${address.cursor ?? ''}:${version}`}
      page={page}
      submit={(input) => publishSelectedCollection({ data: input, headers: { 'X-CSRF-Token': viewer.csrfToken } })}
      onReload={() => {
        void query.refetch().then(() => setVersion((value) => value + 1));
      }}
    />
  );
}
