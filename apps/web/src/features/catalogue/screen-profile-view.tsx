import {
  CatalogueCurrentReading,
  catalogueEditor,
  useEditorLifetime,
  useCurrentReadingActive,
} from './editor-lifetime';
import { useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { contextHref } from '../pages/context-navigation';
import { subjectHref } from '../../subject/subject-href';
import { candidateContext } from '../../subject/candidates';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { RelationTransport } from '../../subject/relation-candidates';
import { ViewHeading, ViewHeadingActions } from '../pages/view-heading';
import { CandidateValue } from '../pages/data';
import { spoilerLevel } from '../pages/shared';
import { SpoilerGate } from '../pages/values';
import { CreateSubjectForm } from './create-subject-form';
import type { CreateFailure, CreateResult, CreatedReader } from './create-subject';
import type { CreateAuthority } from './identity-intake';
import { applyReuse, captureReuse, cloneReferenceGroup } from './reference-reuse';
import {
  captureScreenReuse,
  screenAdmitCreatedReader,
  screenFactDrafts,
  screenFactsFromDrafts,
  type ScreenReuseState,
} from './screen-create-review';
import { ScreenCreateReview } from './screen-create-review-view';
import { ScreenEpisodeMembership, ScreenEpisodeResult } from './screen-episode-membership.tsx';
import {
  episodeJourneyFromCreate,
  episodeType,
  membershipCreateStatement,
  type EpisodeJourney,
  type MembershipDraft,
} from './screen-episode-membership.ts';
import { SubjectTermsEntry } from './subject-terms-entry';
import { ScreenProfileEntry } from './screen-profile-entry';
import { AuthoredFieldEntry } from './authored-field-entry';
import { PublicationEditorEntry } from './publication-editor-entry';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import { RelationEditor } from './relation-editor';
import { AuthoringDepartureBoundary } from '../../threads/authoring-departure';
import { ScreenClassificationReview } from './screen-classification-review';
import { EditorFailure } from './statement-editor-view';
import type { EditorRead } from './statement-editor';
import {
  screenCurrentInspectionId,
  screenCurrentReturnHref,
  type ScreenCurrentOccurrence,
  type ScreenCurrentVisit,
} from './screen-current-visit';
import {
  ScreenInitialFields,
  screenCreationControl,
  screenGroupLabel,
  screenRowId,
  type ScreenRow,
} from './screen-profile-fields';
import {
  screenCreateTypes,
  screenFactId,
  screenGroups,
  screenInitialFacts,
  type ScreenCommand,
  type ScreenGroup,
  type ScreenItem,
  type ScreenRead,
} from './screen-profile';

export type ScreenTransport = {
  load: () => Promise<ScreenRead>;
  create: (command: ScreenCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<CreatedReader>;
  /** Current parent subject.create observation. Fresh create only; independent of series context. */
  eligibility?: () => Promise<CreateAuthority>;
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
  return label.text ? label : { text: '', lang: null };
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
        if (!name.text) return null;
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
  context = candidateContext,
  realm,
  locale,
  session,
  transport,
  search,
  onNavigate,
  classificationHandoffToken,
  visit,
  returnHref,
  handoffReader,
  handoffReaderLive,
}: {
  id?: string | undefined;
  series?: string | undefined;
  context?: string;
  realm?: string;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: ScreenTransport;
  search: EntityPickerSearch;
  onNavigate: (href: string) => void;
  classificationHandoffToken?: string;
  visit?: ScreenCurrentVisit;
  returnHref?: string;
  handoffReader?: string;
  handoffReaderLive?: () => boolean;
}) {
  const lifetime = useEditorLifetime();
  const incarnation = useId();
  const o = { locale: locale as never };
  const client = useQueryClient();
  const queryKey = [
    'screen-profile',
    incarnation,
    id,
    series,
    context,
    realm ?? '',
    locale,
    visit?.source ?? '',
    visit?.subject ?? '',
    visit?.context ?? '',
    visit?.realm ?? '',
    visit?.definition ?? '',
    visit?.occurrence?.holder ?? '',
    visit?.occurrence?.property ?? '',
    visit?.occurrence?.statement ?? '',
    classificationHandoffToken ?? '',
    lifetime.generation,
  ];
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
    staleTime: 0,
    gcTime: 0,
  });
  const [retired, setRetired] = useState(false);
  const [readingRevision, setReadingRevision] = useState(0);
  const readingEpoch = useRef(0);
  const [drafts, setDrafts] = useState<Record<string, ScreenRow[]>>({});
  const [failure, setFailure] = useState<CreateFailure>();
  const [reuse, setReuse] = useState<ScreenReuseState | null>(null);
  const [focusCopy, setFocusCopy] = useState<{ holder: string; index: number; nonce: number }>();
  const retained = useRef<Extract<ScreenRead, { ok: true }>>(undefined);
  function jump(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    for (let parent = target.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
    const focus = target.matches('input, select, textarea, button')
      ? target
      : target.querySelector<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
        );
    if (focus) focus.focus();
    else {
      target.setAttribute('tabindex', '-1');
      target.focus();
    }
  }
  function admitReader(id: string, reader: CreatedReader): CreatedReader {
    return screenAdmitCreatedReader(reader, id);
  }
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
    !retired &&
    !query.isFetching &&
    !query.isError &&
    query.data?.ok &&
    query.data.public?.subject.id === id &&
    query.data.public.subject.context === context &&
    query.data.public.subject.release === releaseDigest(query.data.release) &&
    (!visit || (visit.subject === id && visit.context === context && visit.type === query.data.public.subject.type))
      ? query.data
      : undefined;
  const currentInspection: ScreenCurrentOccurrence | undefined =
    visit?.occurrence &&
    visit.definition === admitted?.public?.subject.release &&
    admitted?.public &&
    visit.occurrence.holder === admitted.public.subject.id &&
    admitted.public.subject.statements[visit.occurrence.property]?.some(
      (statement) =>
        statement.id === visit.occurrence!.statement && statement.property.id === visit.occurrence!.property,
    )
      ? visit.occurrence
      : undefined;
  const retiredInspection = !!visit?.occurrence && !currentInspection;
  const readingChanged = !!visit && !!admitted?.public && visit.definition !== admitted.public.subject.release;
  const currentVisit: ScreenCurrentVisit | undefined =
    visit && admitted?.public
      ? {
          ...visit,
          definition: admitted.public.subject.release,
          ...(readingChanged ? { occurrence: undefined } : {}),
        }
      : undefined;
  const returnAddress =
    returnHref ??
    (visit ? screenCurrentReturnHref(visit) : undefined) ??
    (admitted?.public
      ? contextHref(
          subjectHref(
            { id: admitted.public.subject.id, label: pickText(admitted.public.subject.labels, locale).text },
            locale,
          ).href,
          realm,
        )
      : undefined);
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
          result.data.public?.subject.id === id &&
          result.data.public.subject.context === context &&
          result.data.public.subject.release === releaseDigest(result.data.release) &&
          (!visit ||
            (visit.subject === id && visit.context === context && visit.type === result.data.public.subject.type))
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
        key={JSON.stringify([
          id,
          context,
          realm ?? '',
          locale,
          visit?.source ?? '',
          visit?.definition ?? '',
          visit?.occurrence?.statement ?? '',
          classificationHandoffToken ?? '',
          admitted?.public?.subject.release ?? '',
          lifetime.generation,
        ])}
        id={id}
        context={context}
        realm={realm}
        locale={locale}
        session={session}
        transport={transport}
        search={search}
        read={admitted}
        pending={query.isPending}
        fetching={query.isFetching}
        failure={
          query.data && !query.data.ok
            ? query.data.reason
            : visit && query.data?.ok && query.data.public?.subject.type !== visit.type
              ? 'invalid'
              : 'unavailable'
        }
        revision={`${id}:${context}:${admitted?.public?.subject.release ?? visit?.definition ?? ''}:${readingRevision}`}
        reload={reload}
        intro={intro}
        returnHref={returnAddress}
        {...(currentInspection ? { inspection: currentInspection } : {})}
        inspectionRetired={retiredInspection}
        readingChanged={readingChanged}
        {...(currentVisit ? { currentVisit } : {})}
        focusRequested={!!visit?.occurrence}
        visitIdentity={
          visit
            ? JSON.stringify([
                visit.source,
                visit.subject,
                visit.context,
                visit.realm ?? '',
                visit.locale,
                visit.definition,
                lifetime.generation,
              ])
            : ''
        }
        {...(classificationHandoffToken ? { classificationHandoffToken } : {})}
        {...(handoffReader ? { handoffReader } : {})}
        {...(handoffReaderLive ? { handoffReaderLive } : {})}
        observe={(next) => {
          if (!lifetime.active()) return;
          const observed: ScreenRead =
            next.ok &&
            next.public.subject.id === id &&
            next.public.subject.context === context &&
            next.public.subject.release === releaseDigest(next.release) &&
            (!visit || (visit.type === next.public.subject.type && visit.context === next.public.subject.context))
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
            const admitted = { ...result, reader: admitReader(result.id, result.reader) };
            if (!read.seriesId) return;
            const draft = membershipRef.current;
            setEpisodeJourney(
              episodeJourneyFromCreate(
                admitted,
                draft,
                !!membershipCreateStatement(read.release, read.series?.subject.type, draft),
              ),
            );
          }}
          transport={{
            ...(transport.eligibility ? { eligibility: transport.eligibility } : {}),
            definitions: async (refresh) => {
              const result = refresh ? await query.refetch({ cancelRefetch: false }) : query;
              if (!lifetime.active()) return { ok: false as const, reason: 'denied' as const };
              // Retained data supports private drafts; only a successful read admits new intent.
              const next = !result.isError && result.data?.ok ? result.data : undefined;
              return next?.ok ? { ok: true, types: screenCreateTypes(next.release, locale) } : { ok: false };
            },
            submit: async (command) => {
              const result = await transport.create(command as ScreenCommand);
              if (!lifetime.active()) return { ok: false as const, reason: 'denied' as const };
              setFailure(result.ok ? undefined : result);
              if (!result.ok) return result;
              return { ...result, reader: admitReader(result.id, result.reader) };
            },
            read: async (createdId) => {
              const reader = admitReader(createdId, await transport.read(createdId));
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
              const membership = membershipCreateStatement(read.release, read.series?.subject.type, membershipDraft);
              if (membership) statements.push(membership);
              const prepared = screenInitialFacts(read.release, item, statements);
              setFailure(
                prepared.errors.length ? { ok: false, reason: 'invalid', errors: prepared.errors } : undefined,
              );
              return prepared;
            },
            fields: (type, disabled, canEdit, invalidate) => {
              const rows = drafts[type] ?? [];
              const touch = () => invalidate?.();
              const standalone = !read.seriesId;
              return (
                <>
                  {read.seriesId && (
                    <ScreenEpisodeMembership
                      read={read}
                      locale={locale}
                      disabled={disabled}
                      draft={membershipDraft}
                      change={(next) => {
                        setMembershipDraft(next);
                        touch();
                      }}
                    />
                  )}
                  <ScreenInitialFields
                    key={type}
                    type={type}
                    release={read.release}
                    locale={locale}
                    disabled={disabled}
                    search={search}
                    rows={rows}
                    canEdit={canEdit}
                    errors={failure?.errors ?? []}
                    change={(next) => {
                      setDrafts((previous) => ({ ...previous, [type]: next }));
                      setReuse((currentReuse) =>
                        currentReuse &&
                        currentReuse.type === type &&
                        next.some((row) => screenRowId(row) === currentReuse.source.holder)
                          ? currentReuse
                          : currentReuse?.type === type
                            ? null
                            : currentReuse,
                      );
                      touch();
                    }}
                    omitProperties={read.seriesId ? ['schema:isPartOf'] : []}
                    {...(standalone
                      ? {
                          reuse: reuse && reuse.type === type ? reuse : null,
                          ...(focusCopy ? { focusCopy } : {}),
                          onReuse: (row, index) => {
                            if (!lifetime.active() || !canEdit()) return;
                            const next = captureScreenReuse(rows, type, row, index);
                            if (next) setReuse(next);
                          },
                          onReuseSelected: (selected) => {
                            if (!lifetime.active() || !reuse) return;
                            setReuse({ ...reuse, selected, applied: [], refused: [] });
                          },
                          onReuseApply: () => {
                            if (!lifetime.active() || !canEdit() || !reuse || reuse.type !== type) return;
                            const result = applyReuse(
                              screenFactDrafts(rows),
                              reuse.source,
                              reuse.selected,
                              read.release,
                            );
                            setDrafts((previous) => ({
                              ...previous,
                              [type]: screenFactsFromDrafts(result.drafts, previous[type] ?? []),
                            }));
                            setReuse({ ...reuse, applied: result.applied, refused: result.refused });
                            const first = result.applied[0];
                            if (first) setFocusCopy({ holder: first.holder, index: first.index, nonce: Date.now() });
                            touch();
                          },
                          onReuseCancel: () => setReuse(null),
                          onReuseRefresh: () => {
                            if (!lifetime.active() || !reuse) return;
                            const origin = rows.find((row) => screenRowId(row) === reuse.source.holder);
                            const group = origin?.statement.references[reuse.source.groupIndex];
                            if (!origin || !group) return;
                            const source = { ...reuse.source, snapshot: cloneReferenceGroup(group) };
                            setReuse({
                              ...reuse,
                              source,
                              capture: captureReuse(source, screenFactDrafts(rows)),
                              applied: [],
                              refused: [],
                            });
                          },
                          onReuseOpen: (holder, index) => setFocusCopy({ holder, index, nonce: Date.now() }),
                        }
                      : {})}
                  />
                </>
              );
            },
            control: (pointer, type) => screenCreationControl(pointer, drafts[type] ?? [], read.release, locale),
            ...(read.seriesId
              ? {}
              : {
                  review: ({ item, stale }) => (
                    <ScreenCreateReview
                      item={item as ScreenItem}
                      release={read.release}
                      locale={locale}
                      stale={stale}
                      onJump={jump}
                      factId={(property, index) => {
                        const match = (drafts[item.type] ?? []).filter((row) => row.statement.property.id === property)[
                          index
                        ];
                        return match ? screenRowId(match) : screenFactId(property);
                      }}
                    />
                  ),
                }),
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
  context,
  realm,
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
  returnHref,
  inspection,
  inspectionRetired,
  readingChanged,
  currentVisit,
  focusRequested,
  visitIdentity,
  classificationHandoffToken,
  handoffReader,
  handoffReaderLive,
}: {
  id: string;
  context: string;
  realm?: string;
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
  returnHref?: string;
  inspection?: ScreenCurrentOccurrence;
  inspectionRetired: boolean;
  readingChanged: boolean;
  currentVisit?: ScreenCurrentVisit;
  focusRequested: boolean;
  visitIdentity: string;
  classificationHandoffToken?: string;
  handoffReader?: string;
  handoffReaderLive?: () => boolean;
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
  const href =
    returnHref ?? (subject ? contextHref(subjectHref({ id: subject.id, label: label.text }, locale).href, realm) : '');
  const visible = !!current && session === 'signed-in';
  const readingTitle = m.candidate_current({}, o);
  const focusCancelled = useRef(false);
  const focusCleanup = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    if (!focusRequested) return;
    focusCancelled.current = false;
    const cancel = () => {
      focusCancelled.current = true;
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('pointermove', cancel, true);
    document.addEventListener('focusin', cancel, true);
    document.addEventListener('keydown', cancel, true);
    const cleanup = () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('pointermove', cancel, true);
      document.removeEventListener('focusin', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      if (focusCleanup.current === cleanup) focusCleanup.current = undefined;
    };
    focusCleanup.current = cleanup;
    return cleanup;
  }, [focusRequested, visitIdentity]);
  useLayoutEffect(() => {
    if (!focusRequested || !read?.public || pending || fetching || focusCancelled.current) return;
    const document = globalThis.document;
    if (document.activeElement !== document.body) return;
    const target =
      (inspection ? document.getElementById(screenCurrentInspectionId(inspection.statement)) : undefined) ??
      document.getElementById('screen-correction-entry');
    if (!target?.isConnected) return;
    focusCleanup.current?.();
    target.focus();
  }, [focusRequested, visitIdentity, read, pending, fetching, inspection]);
  return (
    <CatalogueCurrentReading visible={visible} ready={visible} revision={revision}>
      <article
        id="screen-correction-entry"
        tabIndex={-1}
        className="mx-auto w-full max-w-4xl min-w-0 space-y-6 px-4 py-8 sm:px-6 [&_h2]:font-sans [&_h3]:font-sans"
      >
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
              {returnHref ? (
                <a className={buttonVariants({ variant: 'outline' })} href={returnHref}>
                  {m.screen_visit_return({}, o)}
                </a>
              ) : null}
            </>
          )}
          {(pending || fetching) && <p role="status">{m.candidate_loading({}, o)}</p>}
          <Button className={screenActionClassName} disabled={fetching} onClick={reload}>
            {current ? m.candidate_reload({}, o) : m.correction_retry({}, o)}
          </Button>
        </div>
        {subject && current && read && (
          <>
            {readingChanged ? <p role="status">{m.screen_visit_reading_changed({}, o)}</p> : null}
            {inspectionRetired ? <p role="status">{m.screen_visit_occurrence_missing({}, o)}</p> : null}
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
                  {returnHref ? m.screen_visit_return({}, o) : m.candidate_view_public({}, o)}
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
                      {fields.map((property) => {
                        const name = readingName(current, property, locale);
                        const statements = subject.statements[property] ?? [];
                        if (!name.text && !statements.length) return null;
                        return (
                          <div key={property} className="min-w-0 space-y-2">
                            {!statements.length ? (
                              <>
                                <dt
                                  lang={name.lang ?? undefined}
                                  className="min-w-0 max-w-full font-medium [overflow-wrap:anywhere]"
                                >
                                  {name.text}
                                </dt>
                                <dd className="text-sm text-muted-foreground">{m.facts_no_value({}, o)}</dd>
                              </>
                            ) : (
                              statements.map((statement, index) => {
                                const content = (
                                  <div
                                    id={
                                      inspection?.statement === statement.id
                                        ? screenCurrentInspectionId(statement.id)
                                        : undefined
                                    }
                                    tabIndex={inspection?.statement === statement.id ? -1 : undefined}
                                    className="min-w-0 space-y-2 rounded-lg border border-border p-3"
                                  >
                                    <p lang={name.lang ?? undefined} className="font-medium [overflow-wrap:anywhere]">
                                      {name.text}
                                    </p>
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
                                    {currentVisit && currentVisit.occurrence?.statement !== statement.id ? (
                                      <ScreenProfileEntry
                                        id={id}
                                        label={label.text}
                                        locale={locale}
                                        visit={{
                                          ...currentVisit,
                                          occurrence: { holder: id, property, statement: statement.id },
                                        }}
                                        inspect
                                      />
                                    ) : null}
                                  </div>
                                );
                                return (
                                  <div key={statement.id} className="min-w-0">
                                    <dt className="sr-only" lang={name.lang ?? undefined}>
                                      {name.text}
                                    </dt>
                                    <dd className="min-w-0 max-w-full space-y-3 text-sm [overflow-wrap:anywhere]">
                                      {spoilerLevel(statement) > 0 ? (
                                        <SpoilerGate
                                          key={`${visitIdentity}:${statement.id}`}
                                          label={m.subject_spoiler_show({}, o)}
                                          hideLabel={m.subject_spoiler_hide({}, o)}
                                          unmountOnHide
                                        >
                                          {content}
                                        </SpoilerGate>
                                      ) : (
                                        content
                                      )}
                                    </dd>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        );
                      })}
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
                  <ScreenClassificationReview
                    read={privateCurrent}
                    locale={locale}
                    search={search}
                    transport={transport.facts}
                    review={transport.review}
                    observe={observe}
                    {...(classificationHandoffToken ? { handoffToken: classificationHandoffToken } : {})}
                    {...(handoffReader ? { handoffReader } : {})}
                    {...(handoffReaderLive ? { handoffReaderLive } : {})}
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
