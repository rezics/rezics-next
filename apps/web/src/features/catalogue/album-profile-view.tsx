import {
  CatalogueCurrentReading,
  catalogueEditor,
  useEditorLifetime,
  useCurrentReadingVisible,
} from './editor-lifetime';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import type { CandidateTransport } from '../../subject/candidate-review';
import { relationFields, type RelationTransport } from '../../subject/relation-candidates';
import { subjectHref } from '../../subject/subject-href';
import { albumFields, albumType, type AlbumTransport } from './album-profile';
import { AlbumProfileCreate } from './album-profile-create';
import { albumDraftIdentity, albumDraftPopulated, changeAlbumSelection } from './album-correction-selection';
import { DefinitionMeaning } from './definition-meaning';
import { AuthoredFieldEntry } from './authored-field-entry';
import { DefinitionGuideLink } from './definition-guide-view';
import { RelationEditor } from './relation-editor';
import { CharacterClassifications, classificationFields } from './character-profile-classification';
import { EditorFailure, PartValue } from './statement-editor-view';
import { ExactReview, FactField, SelectedFacts } from './subject-facts-view';
import {
  factChanged,
  factLimit,
  factLocked,
  sealFacts,
  sendFacts,
  type FactDraft,
  type FactsCurrent,
  type FactsTransport,
} from './subject-facts';
import { SubjectTermsEntry } from './subject-terms-entry';
import { AuthoringDepartureProvider, useAuthoringDeparture } from '../../threads/authoring-departure';

export type AlbumEditors = {
  facts: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  relations: RelationTransport;
  onSelected?: () => void | Promise<void>;
};

export const AlbumProfile = catalogueEditor(AlbumProfileLive);

function AlbumProfileLive({
  id,
  locale,
  session,
  transport,
  search,
  editors,
}: {
  id?: string;
  locale: string;
  session: string;
  transport: AlbumTransport;
  search: EntityPickerSearch;
  editors?: AlbumEditors;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [...['album-profile', id, locale], lifetime.generation],
    queryFn: transport.load,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [refreshingMetadata, setRefreshingMetadata] = useState(false);
  // The private holder survives a retired observation; only a fresh read supplies authority.
  const retainedRelease = useRef<Release | undefined>(undefined);
  const metadata = useRef<Release | undefined>(undefined);
  const metadataReloading = useRef(false);
  const creationReady = !query.isError && !query.isFetching && !refreshingMetadata;
  const read = query.data?.ok && (id || creationReady) ? query.data : undefined;
  const admitted = !!read?.release.types[albumType];
  metadata.current = !id && admitted ? read?.release : undefined;
  if (metadata.current) retainedRelease.current = metadata.current;
  const [initialRetry, setInitialRetry] = useState<'pending' | 'settled'>();
  const initialRetryRunning = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const failureBoundary = useRef<HTMLDivElement>(null);
  const origin = useMemo(
    () => ({}),
    [query.data, query.error, query.dataUpdatedAt, query.errorUpdatedAt, initialRetry],
  );
  const currentOrigin = useRef<object | undefined>(undefined);
  const initialRecoverable =
    !retainedRelease.current && (query.isError || (query.data && !query.data.ok) || (!id && read && !admitted));
  currentOrigin.current = initialRecoverable && !query.isFetching ? origin : undefined;
  const initialPending = !retainedRelease.current && (query.isFetching || initialRetry === 'pending');
  const retryInitial = async () => {
    if (!lifetime.active() || currentOrigin.current !== origin || initialRetryRunning.current || query.isFetching)
      return;
    initialRetryRunning.current = true;
    currentOrigin.current = undefined;
    setInitialRetry('pending');
    try {
      await query.refetch({ cancelRefetch: false });
    } finally {
      if (lifetime.active()) {
        initialRetryRunning.current = false;
        setInitialRetry('settled');
      }
    }
  };
  // Only deliberate recovery owns focus, after the current result has mounted.
  useLayoutEffect(() => {
    if (initialRetry !== 'settled' || query.isFetching || !lifetime.active()) return;
    (failureBoundary.current ?? heading.current)?.focus();
    setInitialRetry(undefined);
  }, [initialRetry, query.isFetching, lifetime]);
  const reloadMetadata = async () => {
    if (!lifetime.active() || metadataReloading.current || query.isFetching) return;
    metadataReloading.current = true;
    metadata.current = undefined;
    setRefreshingMetadata(true);
    try {
      await query.refetch();
    } finally {
      if (lifetime.active()) {
        metadataReloading.current = false;
        setRefreshingMetadata(false);
      }
    }
  };
  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <header className="space-y-3">
        <PageHeading ref={heading} tabIndex={-1} className="font-sans">
          {id ? m.album_edit({}, o) : m.album_title({}, o)}
        </PageHeading>
        {!id && <p className="max-w-prose text-muted-foreground">{m.album_grain({}, o)}</p>}
        {read && admitted && !id && (
          <div className="flex flex-wrap items-center gap-3">
            <DefinitionMeaning values={read.release.types[albumType]?.labels} locale={locale} />
            <DefinitionGuideLink
              locale={locale}
              address={{
                type: albumType,
                returnTo:
                  id && read.public
                    ? `${subjectHref({ id, label: pickText(read.public.subject.labels, locale).text }, locale).href}/album`
                    : `/${locale}/catalogue/album`,
              }}
            />
          </div>
        )}
      </header>
      {!id && <p className="text-sm text-muted-foreground">{m.album_scope({}, o)}</p>}
      {session !== 'signed-in' && (
        <p role="status">
          {session === 'signed-out'
            ? m.catalogue_create_signed_out({}, o)
            : session === 'unavailable'
              ? m.catalogue_create_unavailable({}, o)
              : m.candidate_loading({}, o)}
        </p>
      )}
      {(query.isPending || initialPending) && <p role="status">{m.candidate_loading({}, o)}</p>}
      {!initialPending && (query.isError || (query.data && !query.data.ok)) && (
        <div ref={failureBoundary} tabIndex={-1} className="space-y-3">
          {query.data && !query.data.ok && query.data.reason === 'concealed' ? (
            <p role="alert">{m.catalogue_create_concealed({}, o)}</p>
          ) : (
            <EditorFailure reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'} locale={locale} />
          )}
          {(id || !retainedRelease.current) && (
            <Button onClick={() => void retryInitial()}>{m.correction_retry({}, o)}</Button>
          )}
        </div>
      )}
      {!initialPending && read && !admitted && (
        <div ref={failureBoundary} tabIndex={-1} className="space-y-3">
          <p role="status">{m.album_missing({}, o)}</p>
          {!id && !retainedRelease.current && (
            <Button onClick={() => void retryInitial()}>{m.correction_reload({}, o)}</Button>
          )}
        </div>
      )}
      {!id && retainedRelease.current && (
        <AlbumProfileCreate
          release={retainedRelease.current}
          metadataCurrent={(release) => metadata.current === release}
          onReload={reloadMetadata}
          locale={locale}
          transport={transport}
          search={search}
          enabled={session === 'signed-in'}
        />
      )}
      {id &&
        read &&
        admitted &&
        (read.public && editors ? (
          <AlbumCorrections
            initial={{ ...read, public: read.public, source: null }}
            locale={locale}
            enabled={session === 'signed-in'}
            search={search}
            editors={editors}
          />
        ) : (
          <div ref={failureBoundary} tabIndex={-1}>
            <EditorFailure reason="unavailable" locale={locale} />
          </div>
        ))}
    </article>
  );
}

function AlbumCorrections({
  initial,
  locale,
  enabled,
  search,
  editors,
}: {
  initial: FactsCurrent;
  locale: string;
  enabled: boolean;
  search: EntityPickerSearch;
  editors: AlbumEditors;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const [read, setRead] = useState<FactsCurrent>(initial);
  const [loadFailure, setLoadFailure] =
    useState<Extract<Awaited<ReturnType<FactsTransport['read']>>, { ok: false }>['reason']>();
  const [loading, setLoading] = useState(false);
  const reading = useRef(false);
  const [revision, setRevision] = useState(0);
  const reload = () => {
    if (!lifetime.active() || reading.current) return;
    reading.current = true;
    setLoading(true);
    setRevision((previous) => previous + 1);
  };
  // Commit the retired observation before I/O, even when a transport resolves immediately.
  // Nested holders must observe the pause to reread their original addresses on recovery.
  useEffect(() => {
    if (!loading) return;
    void (async () => {
      try {
        const next = await editors.facts.read();
        if (!lifetime.active()) return;
        if (
          next.ok &&
          next.public.subject.id === initial.public.subject.id &&
          next.public.subject.type === albumType &&
          next.release.types[albumType]
        ) {
          setRead(next);
          setLoadFailure(undefined);
        } else setLoadFailure(next.ok ? 'invalid' : next.reason);
      } catch {
        if (!lifetime.active()) return;
        setLoadFailure('unavailable');
      } finally {
        if (lifetime.active()) {
          reading.current = false;
          setLoading(false);
        }
      }
    })();
  }, [loading]);
  const visible = !loading && !loadFailure;
  return (
    <div className="space-y-8" aria-busy={loading}>
      {loadFailure && <EditorFailure reason={loadFailure} locale={locale} />}
      {loading && <p role="status">{m.candidate_loading({}, o)}</p>}
      <AuthoringDepartureProvider
        onNavigationLeave={lifetime.retire}
        navigationMessages={{
          title: m.album_edit({}, o),
          unsaved: m.thread_authoring_leave_unsaved({}, o),
          pending: m.thread_authoring_leave_pending({}, o),
        }}
      >
        <CatalogueCurrentReading visible={visible} ready={visible} revision={String(revision)}>
          <AlbumCorrectionWorkspace
            read={read}
            locale={locale}
            enabled={enabled}
            search={search}
            editors={editors}
            onReload={reload}
            holderActive={lifetime.active}
          />
        </CatalogueCurrentReading>
      </AuthoringDepartureProvider>
      <Button type="button" variant="outline" disabled={loading} onClick={() => void reload()}>
        {loadFailure ? m.correction_retry({}, o) : m.correction_reload({}, o)}
      </Button>
    </div>
  );
}

const AlbumCorrectionWorkspace = catalogueEditor(AlbumCorrectionWorkspaceLive);

function AlbumCorrectionWorkspaceLive({
  read: current,
  locale,
  enabled,
  search,
  editors,
  onReload,
  holderActive,
}: {
  read: FactsCurrent;
  locale: string;
  enabled: boolean;
  search: EntityPickerSearch;
  editors: AlbumEditors;
  onReload: () => void;
  holderActive: () => boolean;
}) {
  const lifetime = useEditorLifetime();
  const visible = useCurrentReadingVisible();
  const o = { locale: locale as never };
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [reviewing, setReviewing] = useState<{ property: string; candidate: string; session?: string | undefined }>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const wasVisible = useRef(visible);
  if (wasVisible.current !== visible) {
    wasVisible.current = visible;
    running.current = false;
    setBusy(false);
    if (!visible)
      setDrafts((previous) =>
        previous.map((draft) =>
          draft.command && !draft.result ? { ...draft, result: { ok: false, reason: 'uncertain' } } : draft,
        ),
      );
  }
  const subject = current.public.subject;
  const fields = albumFields(current.release);
  const title = pickText(subject.labels, locale).text;
  const href = subjectHref({ id: subject.id, label: title }, locale).href;
  const label = subject.labels;
  const changed = drafts.filter((draft) => draft.included && factChanged(draft) && !draft.result?.ok);
  // Inclusion selects a batch, not which private assertions the contributor wants to keep.
  // Observe the whole assertion without validating or preparing a new command.
  const unfinished = drafts.some((draft) => !draft.result?.ok && factChanged(draft) && albumDraftPopulated(draft));
  const unresolved =
    busy ||
    drafts.some(
      (draft) =>
        draft.command &&
        (!draft.result || (!draft.result.ok && ['uncertain', 'unavailable'].includes(draft.result.reason))),
    );
  useAuthoringDeparture(() => holderActive() && (unfinished || unresolved), unresolved, JSON.stringify(drafts));
  const admitted = new Set(fields.scalar);
  const staleDraft = drafts.some((draft) => !admitted.has(draft.property));
  const recover = async (target: FactDraft) => {
    if (
      !lifetime.active() ||
      running.current ||
      !visible ||
      !enabled ||
      admitted.has(target.property) ||
      !drafts.includes(target) ||
      !target.command ||
      target.result?.ok
    )
      return false;
    running.current = true;
    setBusy(true);
    try {
      // Replay only this sealed holder through the ordinary protocol, without preparing any draft.
      await sendFacts(
        [{ ...target, included: true }],
        (command) => {
          if (!lifetime.active()) throw new Error('Retired catalogue editor');
          return editors.facts.propose(command);
        },
        (_property, result) => {
          if (!lifetime.active()) return;
          setDrafts((previous) =>
            previous.map((draft) => (draft.command === target.command ? { ...draft, result } : draft)),
          );
        },
      );
      return lifetime.active();
    } finally {
      if (lifetime.active()) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  const submit = async () => {
    if (!lifetime.active()) return;
    if (running.current || !visible || !enabled || staleDraft || !changed.length) return;
    running.current = true;
    setBusy(true);
    try {
      const sealed = sealFacts(current.public.subject.id, current.release, drafts);
      setDrafts(sealed);
      await sendFacts(
        sealed,
        (command) => {
          if (!lifetime.active()) throw new Error('Retired catalogue editor');
          return editors.facts.propose(command);
        },
        (property, result) => {
          if (!lifetime.active()) return;
          setDrafts((previous) =>
            previous.map((draft) => (draft.property === property ? { ...draft, result } : draft)),
          );
        },
      );
      if (!lifetime.active()) return;
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="space-y-8" aria-busy={busy}>
      {visible && (
        <section
          aria-label={m.album_identity({}, o)}
          className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
        >
          <h2
            className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] font-sans text-2xl font-semibold"
            lang={pickText(label ?? {}, locale).lang ?? undefined}
          >
            {title || m.subject_value_unlabelled({}, o)}
          </h2>
          <p className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]">
            <DefinitionMeaning values={current.release.types[subject!.type]?.labels} locale={locale} />
          </p>
          <p className="text-sm font-medium">{m.specialist_identity_scope({}, o)}</p>
          <p className="text-muted-foreground">{m.album_grain({}, o)}</p>
          <p className="text-sm text-muted-foreground">{m.album_scope({}, o)}</p>
          <div className="flex min-w-0 flex-wrap gap-3 [&>a]:h-auto [&>a]:max-w-full [&>a]:whitespace-normal [&>a]:break-words [&>a]:[overflow-wrap:anywhere]">
            <a className={buttonVariants({ variant: 'outline' })} href={href}>
              {m.candidate_view_public({}, o)}
            </a>
            <SubjectTermsEntry id={subject!.id} label={title} locale={locale} />
            <DefinitionGuideLink locale={locale} address={{ type: subject!.type, returnTo: `${href}/album` }} />
          </div>
          <details className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-3">
            <summary className="min-h-8 cursor-pointer whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 pointer-coarse:min-h-11">
              {m.specialist_identity_names({}, o)}
            </summary>
            <dl className="mt-3 min-w-0 space-y-3">
              {Array.from(
                new Set([
                  ...Object.keys(subject!.labels),
                  ...Object.keys(subject!.descriptions),
                  ...Object.keys(subject!.aliases),
                ]),
              ).map((language) => (
                <div key={language} className="min-w-0">
                  <dt className="text-sm text-muted-foreground">{language}</dt>
                  <dd
                    lang={language}
                    className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                  >
                    {subject!.labels[language]}
                  </dd>
                  {subject!.descriptions[language] && (
                    <dd
                      lang={language}
                      className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-sm"
                    >
                      {subject!.descriptions[language]}
                    </dd>
                  )}
                  {!!subject!.aliases[language]?.length && (
                    <dd
                      lang={language}
                      className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-sm text-muted-foreground"
                    >
                      {subject!.aliases[language]!.join(' · ')}
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </details>
          <details className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-3 rounded-xl border border-border p-4">
            <summary className="min-h-8 cursor-pointer whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 pointer-coarse:min-h-11">
              {m.specialist_identity_reference({}, o)}
            </summary>
            <dl className="mt-3 min-w-0 space-y-3">
              <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{m.specialist_identity_subject_id({}, o)}</dt>
                <dd className="min-w-0">
                  <code dir="ltr" className="select-text whitespace-normal break-words [overflow-wrap:anywhere]">
                    {subject!.id}
                  </code>
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{m.specialist_identity_type({}, o)}</dt>
                <dd className="min-w-0">
                  <code dir="ltr" className="select-text whitespace-normal break-words [overflow-wrap:anywhere]">
                    {subject!.type}
                  </code>
                </dd>
              </div>
            </dl>
            <p className="text-sm text-muted-foreground">{m.album_terms_help({}, o)}</p>
          </details>
        </section>
      )}
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {visible && (
          <>
            <h2 className="text-xl font-semibold">{m.album_facts({}, o)}</h2>
            <p className="text-sm text-muted-foreground">
              {m.facts_intro({}, o)} {m.facts_separate_results({}, o)}
            </p>
          </>
        )}
        <fieldset disabled={!enabled || !visible} className="space-y-4">
          {[...new Set([...fields.scalar, ...drafts.map((draft) => draft.property)])].map((property) => {
            const draft = drafts.find((item) => item.property === property);
            return (
              <div key={property} className="space-y-2">
                {admitted.has(property) && (
                  <FactField
                    property={property}
                    read={current}
                    locale={locale}
                    href={href}
                    busy={busy}
                    canStage={drafts.length < factLimit}
                    draft={draft}
                    onReview={(address) => {
                      if (lifetime.active()) setReviewing(address);
                    }}
                    onChange={(draft) => {
                      if (!lifetime.active() || running.current) return;
                      setDrafts((previous) => changeAlbumSelection(previous, { kind: 'revise', draft }));
                    }}
                    onStage={(source) => {
                      if (!lifetime.active() || running.current) return;
                      setDrafts((previous) =>
                        changeAlbumSelection(previous, { kind: 'stage', read: current, property, source }),
                      );
                    }}
                  />
                )}
                {visible && !admitted.has(property) && draft?.command && (
                  <AlbumWithdrawnCommand
                    draft={draft}
                    locale={locale}
                    disabled={busy || !enabled}
                    onRecover={() => recover(draft)}
                    onReview={() => {
                      if (lifetime.active() && draft.result?.ok)
                        setReviewing({ property, candidate: draft.result.candidate, session: draft.result.session });
                    }}
                  />
                )}
                {visible && draft && !draft.command && !factLocked(draft) && (
                  <AlbumDraftRemoval
                    key={albumDraftIdentity(draft)}
                    draft={draft}
                    locale={locale}
                    label={pickText(current.release.properties[property]?.labels ?? {}, locale).text || property}
                    disabled={busy || !enabled}
                    onRemove={() => {
                      if (!lifetime.active() || running.current || !visible || !enabled || draft.command) return;
                      setDrafts((previous) =>
                        changeAlbumSelection(previous, { kind: 'remove', property, target: draft }),
                      );
                    }}
                  />
                )}
              </div>
            );
          })}
          {visible && (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <p>{m.facts_selection({ count: changed.length, limit: factLimit }, o)}</p>
              {drafts.length >= factLimit && <p role="status">{m.album_selection_limit({}, o)}</p>}
              {staleDraft && <EditorFailure reason="stale" locale={locale} />}
              <Button type="submit" disabled={busy || staleDraft || !changed.length}>
                {m.facts_submit({}, o)}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
      {visible && reviewing && (
        <ExactReview
          key={`${reviewing.property}:${reviewing.candidate}`}
          id={subject!.id}
          locale={locale}
          address={reviewing}
          review={editors.review}
        />
      )}
      <section className="space-y-4" aria-label={visible ? m.album_credits_parts({}, o) : undefined}>
        {visible && (
          <>
            <h2 className="text-xl font-semibold">{m.album_credits_parts({}, o)}</h2>
            <p className="text-sm text-muted-foreground">{m.album_credits_help({}, o)}</p>
            {fields!.relations
              .filter((id) => ['credit', 'membership'].includes(current.release.properties[id]!.relation!.group))
              .map((property) => (
                <section key={property} className="space-y-2">
                  <h3 className="font-semibold">
                    <DefinitionMeaning values={current.release.properties[property]!.labels} locale={locale} />
                  </h3>
                  <SelectedFacts property={property} read={current} locale={locale} />
                </section>
              ))}
          </>
        )}
        <fieldset disabled={!enabled || !visible}>
          <RelationEditor
            id={subject!.id}
            locale={locale}
            search={search}
            transport={editors.relations}
            initial={{
              ok: true,
              public: current.public,
              fields: relationFields(current.release, albumType, locale),
              names: Object.fromEntries(
                Object.entries(current.release.properties).map(([id, property]) => [id, property.labels]),
              ),
              page: null,
            }}
            onSelected={async () => {
              if (!lifetime.active()) return;
              await Promise.all([onReload(), editors.onSelected?.()]);
              if (!lifetime.active()) return;
            }}
          />
        </fieldset>
      </section>
      {visible && !!fields!.classifications.length && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">{m.album_classification({}, o)}</h2>
          {enabled ? (
            <CharacterClassifications
              properties={classificationFields(current.release, albumType, fields!.classifications)}
              read={current}
              locale={locale}
              search={search}
              transport={editors.facts}
              review={editors.review}
            />
          ) : (
            fields!.classifications.map((property) => (
              <div key={property} className="space-y-2">
                <h3 className="font-medium">
                  <DefinitionMeaning values={current.release.properties[property]!.labels} locale={locale} />
                </h3>
                {(subject!.statements[property] ?? []).map((statement) => (
                  <div key={statement.id}>
                    <PartValue part={statement} read={current} locale={locale} />
                  </div>
                ))}
                {!subject!.statements[property]?.length && (
                  <p className="text-sm text-muted-foreground">{m.facts_no_value({}, o)}</p>
                )}
              </div>
            ))
          )}
        </section>
      )}
      {visible && !!fields!.authored.length && (
        <section className="space-y-3 rounded-xl border border-border p-4 sm:p-5">
          <h2 className="text-xl font-semibold">{m.album_summary({}, o)}</h2>
          <p className="text-sm text-muted-foreground">{m.album_summary_help({}, o)}</p>
          <AuthoredFieldEntry id={subject!.id} title={title} locale={locale} />
        </section>
      )}
    </div>
  );
}

/** The pending choice belongs to this local draft, independently of its property and siblings. */
/** Private sealed intent is not a current fact or a newly admitted editing surface. */
function AlbumWithdrawnCommand({
  draft,
  locale,
  disabled,
  onRecover,
  onReview,
}: {
  draft: FactDraft;
  locale: string;
  disabled: boolean;
  onRecover: () => Promise<boolean>;
  onReview: () => void;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const [pending, setPending] = useState(false);
  const [recovered, setRecovered] = useState(0);
  const status = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (recovered && lifetime.active()) status.current?.focus();
  }, [recovered]);
  return (
    <section aria-label={draft.property} className="min-w-0 space-y-3 rounded-xl border border-border p-4">
      <h3 className="break-words font-semibold">{draft.property}</h3>
      <p>{m.facts_private({}, o)}</p>
      <EditorFailure reason="stale" locale={locale} />
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
        {JSON.stringify(draft.command!.statement, null, 2)}
      </pre>
      <div ref={status} role="status" tabIndex={-1}>
        {pending ? (
          <p>{m.candidate_loading({}, o)}</p>
        ) : draft.result?.ok ? (
          <p>{m.correction_proposed({}, o)}</p>
        ) : !draft.result || draft.result.reason === 'uncertain' ? (
          <p>{m.facts_uncertain({}, o)}</p>
        ) : (
          <EditorFailure reason={draft.result.reason} locale={locale} />
        )}
      </div>
      {draft.result?.ok ? (
        <Button type="button" variant="outline" disabled={disabled} onClick={onReview}>
          {m.correction_review({}, o)}
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || pending}
          onClick={async () => {
            if (!lifetime.active() || disabled || pending) return;
            setPending(true);
            const performed = await onRecover();
            if (!lifetime.active()) return;
            setPending(false);
            if (performed) setRecovered((previous) => previous + 1);
          }}
        >
          {m.correction_retry({}, o)}
        </Button>
      )}
    </section>
  );
}

function AlbumDraftRemoval({
  draft,
  locale,
  label,
  disabled,
  onRemove,
}: {
  draft: FactDraft;
  locale: string;
  label: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const action = m.album_remove_draft({ field: label }, o);
  const [confirming, setConfirming] = useState(false);
  const section = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const current = useRef({ draft, disabled, onRemove });
  current.current = { draft, disabled, onRemove };
  const editable = () => lifetime.active() && !current.current.disabled && !current.current.draft.command;
  useLayoutEffect(() => {
    if (!editable()) return;
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [confirming, disabled]);
  const cancelRemoval = () => {
    restoreFocus.current = true;
    setConfirming(false);
  };
  const remove = () => {
    if (!editable() || !section.current?.isConnected) return;
    // Return to this property's retained source choice or staging control after the draft disappears.
    const row = section.current.parentElement!;
    const form = row.closest('form');
    flushSync(() => current.current.onRemove());
    const selector =
      'select:not(:disabled), button:not(:disabled):not([hidden]), input:not(:disabled):not([type="hidden"])';
    (row.querySelector<HTMLElement>(selector) ?? form?.querySelector<HTMLElement>(selector))?.focus();
  };
  return (
    <div ref={section} className="space-y-2">
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        className="h-auto min-h-11 max-w-full whitespace-normal break-words"
        disabled={disabled}
        hidden={confirming}
        onClick={() => {
          if (editable()) albumDraftPopulated(current.current.draft) ? setConfirming(true) : remove();
        }}
      >
        {action}
      </Button>
      {confirming && (
        <div
          role="group"
          aria-label={m.candidate_confirm_title({ action }, o)}
          className="space-y-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelRemoval();
            }
          }}
        >
          <p>{m.candidate_confirm_title({ action }, o)}</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={cancel} type="button" variant="outline" disabled={disabled} onClick={cancelRemoval}>
              {m.candidate_cancel({}, o)}
            </Button>
            <Button type="button" variant="destructive" disabled={disabled} onClick={remove}>
              {action}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
