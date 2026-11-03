import {
  CatalogueCurrentReading,
  catalogueEditor,
  useEditorLifetime,
  useCurrentReadingActive,
} from './editor-lifetime';
import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { RelationTransport } from '../../subject/relation-candidates';
import { ViewHeading, ViewHeadingActions } from '../pages/view-heading';
import { CandidateValue } from '../pages/data';
import { CreateSubjectForm } from './create-subject-form';
import type { CreateResult, CreatedReader } from './create-subject';
import { ScreenEpisodeMembership, ScreenEpisodeResult } from './screen-episode-membership.tsx';
import {
  episodeJourneyFromCreate,
  episodeType,
  membershipCreateStatement,
  type EpisodeJourney,
  type MembershipDraft,
} from './screen-episode-membership';
import { SubjectTermsEntry } from './subject-terms-entry';
import { AuthoredFieldEntry } from './authored-field-entry';
import { PublicationEditorEntry } from './publication-editor-entry';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import { RelationEditor } from './relation-editor';
import { AuthoringDepartureBoundary } from '../../threads/authoring-departure';
import { CharacterClassifications, classificationFields } from './character-profile-classification';
import { EditorFailure } from './statement-editor-view';
import type { EditorRead } from './statement-editor';
import { ScreenInitialFields, screenCreationControl, screenGroupLabel, type ScreenRow } from './screen-profile-fields';
import {
  screenCreateTypes,
  screenGroups,
  screenInitialFacts,
  type ScreenCommand,
  type ScreenRead,
  type ScreenGroup,
} from './screen-profile';

export type ScreenTransport = {
  load: () => Promise<ScreenRead>;
  create: (command: ScreenCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<CreatedReader>;
  facts?: FactsTransport;
  review?: (property: string, session?: string) => CandidateTransport;
  relations?: RelationTransport;
  createdRelations?: (id: string) => RelationTransport;
};

const screenActionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const screenSummaryClassName =
  'min-h-11 max-w-full cursor-pointer py-2 font-semibold [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1';

export const ScreenProfile = catalogueEditor(ScreenProfileLive);

type ScreenCurrent = Extract<ScreenRead, { ok: true }> & {
  public: NonNullable<Extract<ScreenRead, { ok: true }>['public']>;
};

// Reading includes supplied facts even when the active release no longer offers their editor.
function readingGroups(read: ScreenCurrent) {
  const groups = screenGroups(read.release, read.public.subject.type);
  const offered = new Set(Object.values(groups).flat());
  for (const [property, statements] of Object.entries(read.public.subject.statements)) {
    if (offered.has(property) || !statements.length) continue;
    const datatype = statements[0]!.property.data_type;
    groups[
      datatype === 'document'
        ? 'authored'
        : datatype === 'time'
          ? 'dates'
          : datatype === 'quantity'
            ? 'amounts'
            : 'text'
    ].push(property);
  }
  return groups;
}

function readingName(read: ScreenCurrent, property: string, locale: string) {
  const label = pickText(read.release.properties[property]?.labels ?? {}, locale);
  const related = pickText(read.public.related[property]?.labels ?? {}, locale);
  return label.text ? label : related.text ? related : { text: property, lang: null };
}

function ScreenPart({
  part,
  read,
  locale,
}: {
  part: ComponentProps<typeof CandidateValue>['snak'];
  read: ScreenCurrent;
  locale: string;
}) {
  return (
    <CandidateValue
      snak={part}
      related={read.public.related}
      subject={read.public.subject.id}
      documents={'documents' in read.public ? read.public.documents : undefined}
      locale={locale}
    />
  );
}

function ScreenParts({
  parts,
  read,
  locale,
}: {
  parts: ComponentProps<typeof CandidateValue>['snak'][];
  read: ScreenCurrent;
  locale: string;
}) {
  return (
    <dl className="min-w-0 space-y-2">
      {parts.map((part, index) => {
        const name = readingName(read, part.property.id, locale);
        return (
          <div key={index} className="min-w-0 space-y-1">
            <dt lang={name.lang ?? undefined} className="text-muted-foreground">
              {name.text}
            </dt>
            <dd className="min-w-0">
              <ScreenPart part={part} read={read} locale={locale} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function ScreenProfileLive({
  id,
  series,
  locale,
  session,
  transport,
  search,
  onNavigate,
}: {
  id?: string | undefined;
  series?: string | undefined;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: ScreenTransport;
  search: EntityPickerSearch;
  onNavigate: (href: string) => void;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const client = useQueryClient();
  const queryKey = ['screen-profile', id, series, locale, lifetime.generation];
  const [membershipDraft, setMembershipDraft] = useState<MembershipDraft>();
  const [episodeJourney, setEpisodeJourney] = useState<Exclude<EpisodeJourney, { stage: 'edit' }>>();
  const membershipRef = useRef(membershipDraft);
  const journeyRef = useRef(episodeJourney);
  membershipRef.current = membershipDraft;
  journeyRef.current = episodeJourney;
  const query = useQuery({
    queryKey,
    queryFn: transport.load,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const [retired, setRetired] = useState(false);
  const [readingRevision, setReadingRevision] = useState(0);
  const readingEpoch = useRef(0);
  const [drafts, setDrafts] = useState<Record<string, ScreenRow[]>>({});
  const retained = useRef<Extract<ScreenRead, { ok: true }>>(undefined);
  // Creation metadata is private draft scaffolding, never an existing subject's authority.
  if (!id && query.data?.ok) retained.current = query.data;
  const read = query.data?.ok ? query.data : retained.current;
  const [creationRetry, setCreationRetry] = useState<'pending' | 'settled'>();
  const creationRetryRunning = useRef(false);
  const creationHeading = useRef<HTMLHeadingElement>(null);
  const creationAction = useRef<HTMLButtonElement>(null);
  const creationIntent = useRef<{ trigger: HTMLButtonElement; dispose: () => void } | null>(null);
  const origin = useMemo(
    () => ({}),
    [query.data, query.error, query.dataUpdatedAt, query.errorUpdatedAt, creationRetry],
  );
  const currentOrigin = useRef<object | undefined>(undefined);
  currentOrigin.current = !id && !read && !query.isFetching && !query.isPending ? origin : undefined;
  const creationPending = query.isPending || query.isFetching || creationRetry === 'pending';
  const retryCreation = async (event: MouseEvent<HTMLButtonElement>) => {
    if (!lifetime.active() || currentOrigin.current !== origin || creationRetryRunning.current) return;
    creationRetryRunning.current = true;
    currentOrigin.current = undefined;
    creationIntent.current?.dispose();
    const trigger = event.currentTarget;
    const document = trigger.ownerDocument;
    if (event.detail === 0 && document.activeElement === trigger) {
      const intent = { trigger, dispose };
      function dispose() {
        if (creationIntent.current === intent) creationIntent.current = null;
        document.removeEventListener('focusin', moved, true);
        document.removeEventListener('pointerdown', dispose, true);
        document.defaultView?.removeEventListener('blur', dispose);
      }
      function moved(event: FocusEvent) {
        if (event.target !== trigger) dispose();
      }
      creationIntent.current = intent;
      document.addEventListener('focusin', moved, true);
      document.addEventListener('pointerdown', dispose, true);
      document.defaultView?.addEventListener('blur', dispose);
    }
    setCreationRetry('pending');
    try {
      await query.refetch({ cancelRefetch: false });
    } finally {
      if (lifetime.active()) {
        creationRetryRunning.current = false;
        setCreationRetry('settled');
      }
    }
  };
  useLayoutEffect(() => () => creationIntent.current?.dispose(), [lifetime]);
  useLayoutEffect(() => {
    if (creationRetry !== 'settled' || query.isFetching || !lifetime.active()) return;
    const intent = creationIntent.current;
    intent?.dispose();
    if (intent) {
      const document = intent.trigger.ownerDocument;
      const active = document.activeElement;
      if (active === intent.trigger || active === document.body) {
        const target = creationAction.current ?? creationHeading.current;
        if (target?.isConnected && active !== target) target.focus();
      }
    }
    setCreationRetry(undefined);
  }, [creationRetry, query.isFetching, lifetime]);
  const admitted =
    !retired && !query.isFetching && !query.isError && query.data?.ok && query.data.public?.subject.id === id
      ? query.data
      : undefined;
  const reload = () => {
    if (!lifetime.active()) return;
    const epoch = ++readingEpoch.current;
    flushSync(() => {
      setReadingRevision(epoch);
      setRetired(true);
    });
    void query
      .refetch({ cancelRefetch: false })
      .then((result) => {
        if (
          lifetime.active() &&
          readingEpoch.current === epoch &&
          result.isSuccess &&
          result.data?.ok &&
          result.data.public?.subject.id === id
        )
          setRetired(false);
      })
      .catch(() => {});
  };
  const intro = (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>{m.screen_intro({}, o)}</p>
      <p>{m.screen_native_help({}, o)}</p>
    </div>
  );
  if (id)
    return (
      <ScreenCorrection
        id={id}
        locale={locale}
        session={session}
        transport={transport}
        search={search}
        read={admitted}
        pending={query.isPending}
        fetching={query.isFetching}
        failure={query.data && !query.data.ok ? query.data.reason : 'unavailable'}
        revision={`${id}:${readingRevision}`}
        reload={reload}
        intro={intro}
        observe={(next) => {
          if (!lifetime.active()) return;
          const observed: ScreenRead =
            next.ok && next.public.subject.id === id
              ? { ok: true, release: next.release, public: next.public }
              : { ok: false, reason: !next.ok && next.reason === 'denied' ? 'concealed' : 'unavailable' };
          client.setQueryData<ScreenRead>(queryKey, observed);
        }}
      />
    );
  if (!read)
    return (
      <article aria-busy={creationPending} className="mx-auto w-full max-w-4xl min-w-0 space-y-5 p-4 sm:p-6">
        <ViewHeadingActions label={id ? m.screen_edit({}, o) : m.screen_title({}, o)} headingClassName="font-sans" />
        {creationPending ? (
          <p role="status">{m.candidate_loading({}, o)}</p>
        ) : (
          <>
            {query.data && !query.data.ok && query.data.reason === 'concealed' ? (
              <p role="alert">{m.catalogue_create_concealed({}, o)}</p>
            ) : (
              <EditorFailure
                locale={locale}
                reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'}
              />
            )}
          </>
        )}
        {(!query.isPending || creationRetry) && (
          <Button
            ref={creationAction}
            className={screenActionClassName}
            disabled={creationPending}
            onClick={(event) => void retryCreation(event)}
          >
            {m.correction_retry({}, o)}
          </Button>
        )}
      </article>
    );
  if (!id)
    return (
      <div className="mx-auto w-full max-w-4xl min-w-0 space-y-6 px-4 py-8 sm:px-6">
        <header className="min-w-0 space-y-3">
          <ViewHeading
            label={read.seriesId ? m.screen_episode_from_series({}, o) : m.screen_title({}, o)}
            headingRef={creationHeading}
            headingTabIndex={-1}
            headingClassName="font-sans"
          />
          {intro}
        </header>
        <CreateSubjectForm
          locale={locale}
          session={session}
          onNavigate={(href) => {
            if (read.seriesId) return;
            onNavigate(href);
          }}
          onCreated={(result) => {
            if (!read.seriesId) return;
            const draft = membershipRef.current;
            setEpisodeJourney(
              episodeJourneyFromCreate(
                result,
                draft,
                !!membershipCreateStatement(read.release, read.series?.subject.type, draft),
              ),
            );
          }}
          transport={{
            definitions: async (refresh) => {
              const result = refresh ? await query.refetch({ cancelRefetch: false }) : query;
              if (!lifetime.active()) return { ok: false as const, reason: 'denied' as const };
              // Retained data supports private drafts; only a successful read admits new intent.
              const next = !result.isError && result.data?.ok ? result.data : undefined;
              return next?.ok ? { ok: true, types: screenCreateTypes(next.release, locale) } : { ok: false };
            },
            submit: (command) => transport.create(command as ScreenCommand),
            read: async (createdId) => {
              const reader = await transport.read(createdId);
              const current = journeyRef.current;
              const draft = membershipRef.current;
              if (lifetime.active() && current && current.id === createdId) {
                setEpisodeJourney(
                  episodeJourneyFromCreate(
                    { ok: true, id: createdId, reader },
                    draft,
                    !!membershipCreateStatement(read.release, read.series?.subject.type, draft),
                  ),
                );
              }
              return reader;
            },
          }}
          profile={{
            title: read.seriesId ? m.screen_episode_from_series({}, o) : m.screen_title({}, o),
            scope: read.seriesId ? 'screen-episode-from-series' : 'screen-profile',
            hideHeading: true,
            href: read.seriesId
              ? `/${locale}/catalogue/screen?series=${encodeURIComponent(read.seriesId)}`
              : `/${locale}/catalogue/screen`,
            ...(read.seriesId ? { type: episodeType, readOnlyType: true } : {}),
            labelLanguage: (type) => pickText(read.release.types[type]?.labels ?? {}, locale).lang ?? undefined,
            descriptionLanguage: (type) =>
              pickText(read.release.types[type]?.descriptions ?? {}, locale).lang ?? undefined,
            prepare: (item) => {
              const statements = (drafts[item.type] ?? []).map((row) => row.statement);
              const membership = membershipCreateStatement(
                read.release,
                read.series?.subject.type,
                membershipDraft,
              );
              if (membership) statements.push(membership);
              return screenInitialFacts(read.release, item, statements);
            },
            fields: (type, disabled) => (
              <>
                {read.seriesId && (
                  <ScreenEpisodeMembership
                    read={read}
                    locale={locale}
                    disabled={disabled}
                    draft={membershipDraft}
                    change={setMembershipDraft}
                  />
                )}
                <ScreenInitialFields
                  key={type}
                  type={type}
                  release={read.release}
                  locale={locale}
                  disabled={disabled}
                  search={search}
                  rows={drafts[type] ?? []}
                  change={(rows) => setDrafts((previous) => ({ ...previous, [type]: rows }))}
                  omitProperties={read.seriesId ? ['schema:isPartOf'] : []}
                />
              </>
            ),
            control: (pointer, type) => screenCreationControl(pointer, drafts[type] ?? [], read.release, locale),
          }}
        />
        {episodeJourney && read.seriesId && (
          <ScreenEpisodeResult
            journey={episodeJourney}
            series={{
              id: read.series?.subject.id ?? read.seriesId,
              label: read.series ? pickText(read.series.subject.labels, locale).text : '',
            }}
            locale={locale}
            membership={membershipDraft}
            search={search}
            relations={transport.createdRelations}
            onLinked={setEpisodeJourney}
            onRetryRead={() => {
              const current = journeyRef.current;
              if (!current || current.stage !== 'unread') return;
              void transport.read(current.id).then((reader) => {
                if (!lifetime.active()) return;
                const draft = membershipRef.current;
                setEpisodeJourney(
                  episodeJourneyFromCreate(
                    { ok: true, id: current.id, reader },
                    draft,
                    !!membershipCreateStatement(read.release, read.series?.subject.type, draft),
                  ),
                );
              });
            }}
          />
        )}
      </div>
    );
}

/** Keep only the private holders mounted across refusal, with no retained public display authority. */
function ScreenCorrection({
  id,
  locale,
  session,
  transport,
  search,
  read,
  pending,
  fetching,
  failure,
  revision,
  reload,
  intro,
  observe,
}: {
  id: string;
  locale: string;
  session: string;
  transport: ScreenTransport;
  search: EntityPickerSearch;
  read: Extract<ScreenRead, { ok: true }> | undefined;
  pending: boolean;
  fetching: boolean;
  failure: Extract<ScreenRead, { ok: false }>['reason'];
  revision: string;
  reload: () => void;
  intro: React.ReactNode;
  observe: (next: EditorRead) => void;
}) {
  const o = { locale: locale as never };
  const current = useMemo(
    () => (read?.public ? { ok: true as const, release: read.release, public: read.public, source: null } : null),
    [read],
  );
  const retained = useRef<NonNullable<typeof current>>(undefined);
  if (current) retained.current = current;
  const privateCurrent = retained.current;
  const subject = current?.public.subject;
  const label = pickText(subject?.labels ?? {}, locale);
  const href = subject ? subjectHref({ id: subject.id, label: label.text }, locale).href : '';
  const visible = !!current && session === 'signed-in';
  const readingTitle = m.candidate_current({}, o);
  return (
    <CatalogueCurrentReading visible={visible} ready={visible} revision={revision}>
      <article className="mx-auto w-full max-w-4xl min-w-0 space-y-6 px-4 py-8 sm:px-6 [&_h2]:font-sans [&_h3]:font-sans">
        <ViewHeadingActions label={m.screen_edit({}, o)} headingClassName="font-sans" />
        <div className="min-w-0 space-y-2" aria-busy={fetching}>
          {!current && !pending && (
            <>
              <p role="alert">{m.screen_refresh_failed({}, o)}</p>
              {failure === 'concealed' ? (
                <p role="alert">{m.catalogue_create_concealed({}, o)}</p>
              ) : (
                <EditorFailure locale={locale} reason={failure} />
              )}
            </>
          )}
          {(pending || fetching) && <p role="status">{m.candidate_loading({}, o)}</p>}
          <Button className={screenActionClassName} disabled={fetching} onClick={reload}>
            {current ? m.candidate_reload({}, o) : m.correction_retry({}, o)}
          </Button>
        </div>
        {subject && current && read && (
          <>
            <header className="min-w-0 space-y-3">
              <a
                href={href}
                lang={label.lang ?? undefined}
                className="inline-flex min-h-11 min-w-11 max-w-full items-center [overflow-wrap:anywhere] py-1 font-sans text-2xl font-semibold underline md:pointer-fine:min-h-8"
              >
                {label.text || m.subject_value_unlabelled({}, o)}
              </a>
              <p
                lang={pickText(read.release.types[subject.type]?.labels ?? {}, locale).lang ?? undefined}
                className="min-w-0 max-w-full [overflow-wrap:anywhere]"
              >
                {pickText(read.release.types[subject.type]?.labels ?? {}, locale).text}
              </p>
              {intro}
              <nav
                className="flex min-w-0 flex-wrap items-start gap-2 [&>a]:h-auto [&>a]:min-h-11 [&>a]:min-w-11 [&>a]:max-w-full [&>a]:whitespace-normal [&>a]:py-2 [&>a]:[overflow-wrap:anywhere] md:pointer-fine:[&>a]:min-h-8 md:pointer-fine:[&>a]:py-1"
                aria-label={m.facts_other_editors({}, o)}
              >
                <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={href}>
                  {m.candidate_view_public({}, o)}
                </a>
                <SubjectTermsEntry id={id} label={label.text} locale={locale} />
                <PublicationEditorEntry work={id} locale={locale} />
              </nav>
            </header>
            <section className="min-w-0 space-y-5" aria-label={readingTitle}>
              <h2 className="text-xl font-semibold">{readingTitle}</h2>
              {Object.entries(readingGroups(current))
                .filter(([, fields]) => fields.length)
                .map(([group, fields]) => (
                  <section key={group} className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
                    <h3 className="min-w-0 max-w-full text-lg font-semibold [overflow-wrap:anywhere]">
                      {screenGroupLabel(group as ScreenGroup, locale)}
                    </h3>
                    <dl className="min-w-0 space-y-4">
                      {fields.map((property) => (
                        <div key={property} className="min-w-0 space-y-2">
                          <dt
                            lang={readingName(current, property, locale).lang ?? undefined}
                            className="min-w-0 max-w-full font-medium [overflow-wrap:anywhere]"
                          >
                            {readingName(current, property, locale).text}
                          </dt>
                          <dd className="min-w-0 max-w-full space-y-3 text-sm [overflow-wrap:anywhere]">
                            {!subject.statements[property]?.length && (
                              <p className="text-muted-foreground">{m.facts_no_value({}, o)}</p>
                            )}
                            {(subject.statements[property] ?? []).map((statement, index) => (
                              <div key={statement.id} className="min-w-0 space-y-2">
                                <p className="font-medium">{m.facts_selected_value({ number: index + 1 }, o)}</p>
                                <p className="text-muted-foreground">
                                  {m.candidate_rank({}, o)}:{' '}
                                  {statement.rank === 'preferred'
                                    ? m.candidate_rank_preferred({}, o)
                                    : statement.rank === 'deprecated'
                                      ? m.changes_rank_deprecated({}, o)
                                      : m.candidate_rank_normal({}, o)}
                                </p>
                                <ScreenPart part={statement} read={current} locale={locale} />
                                <ScreenParts parts={statement.qualifiers} read={current} locale={locale} />
                                <ol className="min-w-0 space-y-2">
                                  {statement.references.map((reference, index) => (
                                    <li
                                      key={index}
                                      className="min-w-0 max-w-full border-s-2 ps-3 [overflow-wrap:anywhere]"
                                    >
                                      <p className="text-muted-foreground">
                                        {m.correction_references({}, o)} {index + 1}
                                      </p>
                                      <ScreenParts parts={reference.parts} read={current} locale={locale} />
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            ))}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    {group === 'authored' && <AuthoredFieldEntry id={id} title={label.text} locale={locale} />}
                  </section>
                ))}
            </section>
          </>
        )}
        {session !== 'signed-in' ? (
          <p role="status">
            {session === 'signed-out'
              ? m.catalogue_create_signed_out({}, o)
              : session === 'unavailable'
                ? m.candidate_unavailable({}, o)
                : m.candidate_loading({}, o)}
          </p>
        ) : (
          <>
            {privateCurrent && transport.facts && transport.review && (
              <details hidden={!visible} className="min-w-0 rounded-xl border border-border p-4" open>
                {visible && <summary className={screenSummaryClassName}>{m.facts_title({}, o)}</summary>}
                <ScreenFacts
                  observe={observe}
                  embedded
                  initial={privateCurrent}
                  locale={locale}
                  transport={transport.facts}
                  review={transport.review}
                />
              </details>
            )}
            {privateCurrent && transport.facts && transport.review && (
              <details hidden={!visible} className="min-w-0 rounded-xl border border-border p-4" open>
                {visible && <summary className={screenSummaryClassName}>{m.screen_classification({}, o)}</summary>}
                <AuthoringDepartureBoundary>
                  <CharacterClassifications
                    properties={classificationFields(
                      privateCurrent.release,
                      privateCurrent.public.subject.type,
                      screenGroups(privateCurrent.release, privateCurrent.public.subject.type).classification,
                    )}
                    read={privateCurrent}
                    locale={locale}
                    search={search}
                    transport={transport.facts}
                    review={transport.review}
                  />
                </AuthoringDepartureBoundary>
              </details>
            )}
            {privateCurrent && transport.relations && (
              <details hidden={!visible} className="min-w-0 space-y-4 rounded-xl border border-border p-4">
                {visible && <summary className={screenSummaryClassName}>{m.screen_credits_parts({}, o)}</summary>}
                <RelationEditor embedded id={id} locale={locale} search={search} transport={transport.relations} />
              </details>
            )}
          </>
        )}
      </article>
    </CatalogueCurrentReading>
  );
}

// An embedded scalar reread observes the same page authority without a second public request.
function ScreenFacts({
  transport,
  observe,
  ...props
}: ComponentProps<typeof SubjectFacts> & {
  observe: (next: EditorRead) => void;
}) {
  const active = useCurrentReadingActive();
  return (
    <SubjectFacts
      {...props}
      transport={{
        ...transport,
        read: async () => {
          if (!active()) throw new Error('Retired catalogue editor');
          let next: EditorRead;
          try {
            next = await transport.read();
          } catch {
            next = { ok: false, reason: 'unavailable' };
          }
          if (!active()) throw new Error('Retired catalogue editor');
          observe(next);
          return next;
        },
      }}
    />
  );
}
