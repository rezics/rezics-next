import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useId, useLayoutEffect, useRef, useSyncExternalStore, type ComponentProps, type MouseEvent } from 'react';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import type { SubjectRead } from '@rezics/client';
import { releaseDigest, type Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { PlainLink, spoilerLevel, type PageLink, type Stmt } from '../pages/shared';
import { SpoilerGate } from '../pages/values';
import { CandidateValue } from '../pages/data';
import { ScreenProfileEntry } from './screen-profile-entry';
import { catalogueEntries } from './catalogue-entry';
import { isScreenType, screenReaderVisit, type ScreenReaderVisit } from './screen-profile';
import { screenGroupLabel } from './screen-profile-fields';
import type { ScreenGroup } from './screen-profile';
import { candidateContext } from '../../subject/candidates';
import { browserObservation } from '../../session';
import { loadScreenProfileFactsForReader, loadScreenProfileForReader } from './screen-episode-reader/actions';
import {
  screenEpisodeCursorIntent,
  screenEpisodeReadingAddress,
  screenEpisodeReturn,
  type ScreenEpisodeOrigin,
} from './screen-episode-reader/navigation';
import { ScreenEpisodeList } from './screen-episode-reader/view';
import type { ScreenEpisodeRead, ScreenProfileReaderLoad } from './screen-episode-reader/read';
import { useScreenEpisodeVisit } from './screen-episode-reader/visit/owner';
import { ProfileBoundNotes, ProfileLibraryNote, ProfileSourceList } from './music-reader-view';
import type { ProfileBound, ProfileReaderState } from './music-reader';
import {
  screenCurrentEntryId,
  screenCurrentInspectionId,
  screenCurrentReturnValue,
  screenCurrentSourceAddress,
  screenCurrentVisitAvailable,
  type ScreenCurrentOccurrence,
  type ScreenCurrentReturn,
  type ScreenCurrentVisit,
} from './screen-current-visit';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';

function options(locale: string) {
  return { locale: locale as never };
}

function screenStateCopy(state: ProfileReaderState, locale: string) {
  const o = options(locale);
  if (state === 'loading') return m.candidate_loading({}, o);
  if (state === 'denied') return m.screen_reader_denied({}, o);
  if (state === 'stale') return m.screen_reader_stale({}, o);
  if (state === 'empty') return m.screen_reader_empty({}, o);
  return m.screen_reader_unavailable({}, o);
}

function titles(id: string, locale: string) {
  return ['dates', 'amounts', 'credits', 'parts', 'classification', 'text', 'authored'].includes(id)
    ? screenGroupLabel(id as ScreenGroup, locale)
    : id;
}

function statementOf(read: SubjectRead, occurrence: ScreenCurrentOccurrence): Stmt | undefined {
  if (occurrence.holder !== read.subject.id) return undefined;
  const statements = read.subject.statements[occurrence.property];
  return Array.isArray(statements)
    ? (statements.find((statement) => statement.id === occurrence.statement && statement.property.id === occurrence.property) as
        | Stmt
        | undefined)
    : undefined;
}

function ScreenPart({
  part,
  read,
  locale,
}: {
  part: ComponentProps<typeof CandidateValue>['snak'];
  read: SubjectRead;
  locale: string;
}) {
  return (
    <CandidateValue
      snak={part}
      related={read.related}
      subject={read.subject.id}
      documents={'documents' in read ? read.documents : undefined}
      locale={locale}
    />
  );
}

function ScreenOccurrence({
  statement,
  property,
  read,
  release,
  locale,
  readerSpoilerLevel,
  visit,
  inspect,
  detailed = false,
  targetId,
  identity,
}: {
  statement: Stmt;
  property: string;
  read: SubjectRead;
  release: Release;
  locale: string;
  readerSpoilerLevel: number;
  visit?: ScreenCurrentVisit;
  inspect?: boolean;
  detailed?: boolean;
  targetId?: string;
  identity: string;
}) {
  const o = options(locale);
  const propertyLabel = pickText(release.properties[property]?.labels ?? {}, locale);
  const content = (
    <div id={targetId} data-screen-current-evidence={inspect ? 'selected' : undefined} tabIndex={targetId ? -1 : undefined} className="min-w-0 space-y-2 rounded-lg border border-border p-4">
      {propertyLabel.text ? (
        <h3 lang={propertyLabel.lang ?? undefined} className="font-medium">{propertyLabel.text}</h3>
      ) : null}
      <CandidateValue
        snak={statement}
        related={read.related}
        subject={read.subject.id}
        documents={'documents' in read ? read.documents : undefined}
        locale={locale}
      />
      {detailed ? (
        <p className="text-sm text-muted-foreground">
          {m.candidate_rank({}, o)}:{' '}
          {statement.rank === 'preferred'
            ? m.candidate_rank_preferred({}, o)
            : statement.rank === 'deprecated'
              ? m.changes_rank_deprecated({}, o)
              : m.candidate_rank_normal({}, o)}
        </p>
      ) : null}
      {detailed && statement.qualifiers.length ? (
        <dl className="min-w-0 space-y-2">
          {statement.qualifiers.map((part, index) => {
            const label = pickText(release.properties[part.property.id]?.labels ?? {}, locale);
            if (!label.text) return null;
            return (
              <div key={`${part.property.id}:${index}`} className="min-w-0 space-y-1">
                <dt lang={label.lang ?? undefined} className="text-sm text-muted-foreground">{label.text}</dt>
                <dd><ScreenPart part={part} read={read} locale={locale} /></dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {detailed && statement.references.length ? (
        <ol className="min-w-0 space-y-3">
          {statement.references.map((reference, referenceIndex) => (
            <li key={referenceIndex} className="min-w-0 space-y-2 border-s-2 ps-3">
              <p className="text-sm text-muted-foreground">{m.correction_references({}, o)} {referenceIndex + 1}</p>
              <dl className="min-w-0 space-y-2">
                {reference.parts.map((part, index) => {
                  const label = pickText(release.properties[part.property.id]?.labels ?? {}, locale);
                  if (!label.text) return null;
                  return (
                    <div key={`${part.property.id}:${index}`} className="min-w-0 space-y-1">
                      <dt lang={label.lang ?? undefined} className="text-sm text-muted-foreground">{label.text}</dt>
                      <dd><ScreenPart part={part} read={read} locale={locale} /></dd>
                    </div>
                  );
                })}
              </dl>
            </li>
          ))}
        </ol>
      ) : null}
      {visit ? (
        <ScreenProfileEntry
          id={read.subject.id}
          label={pickText(read.subject.labels, locale).text}
          locale={locale}
          inspect
          visit={{ ...visit, occurrence: { holder: read.subject.id, property, statement: statement.id } }}
        />
      ) : null}
    </div>
  );
  return spoilerLevel(statement) > readerSpoilerLevel ? (
    <SpoilerGate
      key={`${identity}:${statement.id}`}
      label={m.subject_spoiler_show({}, o)}
      hideLabel={m.subject_spoiler_hide({}, o)}
      unmountOnHide
    >
      {content}
    </SpoilerGate>
  ) : content;
}

function ScreenCurrentEvidence({
  publicRead,
  release,
  inspection,
  locale,
  readerSpoilerLevel,
  identity,
  targetId,
}: {
  publicRead: SubjectRead;
  release: Release;
  inspection: ScreenCurrentOccurrence;
  locale: string;
  readerSpoilerLevel: number;
  identity: string;
  targetId?: string;
}) {
  const occurrence = statementOf(publicRead, inspection);
  const hidden = occurrence && spoilerLevel(occurrence) > readerSpoilerLevel;
  return (
    <section data-slot="screen-current-evidence" className="min-w-0 space-y-3">
      <ContentItemHeading level={2} className="text-xl font-semibold">{m.screen_visit_inspect({}, options(locale))}</ContentItemHeading>
      {!occurrence || hidden ? (
        <p role="status">{m.screen_visit_occurrence_missing({}, options(locale))}</p>
      ) : (
        <ScreenOccurrence
          statement={occurrence}
          property={inspection.property}
          read={publicRead}
          release={release}
          locale={locale}
          readerSpoilerLevel={readerSpoilerLevel}
          inspect
          detailed
          targetId={targetId}
          identity={identity}
        />
      )}
    </section>
  );
}

export function ScreenProfileReader({
  locale,
  release,
  public: publicRead,
  bounds,
  reason,
  loading,
  onRetry,
  link = PlainLink,
  episodeRead,
  episodeLoading = false,
  onEpisodeRetry,
  episodeOrigin,
  readerSpoilerLevel = 0,
  episodeVisitKey,
  episodeVisit,
  currentVisit,
  inspection,
  unsupportedCorrection = false,
  globalHref,
  returnHref,
  visitIdentity = '',
  returnNotice = false,
}: {
  locale: string;
  release?: Release;
  public?: SubjectRead | null;
  bounds?: readonly ProfileBound[];
  reason?: Exclude<ProfileReaderState, 'ready' | 'empty'>;
  loading?: boolean;
  onRetry?: () => void;
  link?: PageLink;
  episodeRead?: ScreenEpisodeRead;
  episodeLoading?: boolean;
  onEpisodeRetry?: () => void;
  episodeOrigin?: ScreenEpisodeOrigin;
  readerSpoilerLevel?: number;
  episodeVisitKey?: string;
  episodeVisit?: ReturnType<typeof useScreenEpisodeVisit>;
  currentVisit?: ScreenCurrentVisit;
  inspection?: ScreenCurrentOccurrence;
  unsupportedCorrection?: boolean;
  globalHref?: string;
  returnHref?: string;
  visitIdentity?: string;
  returnNotice?: boolean;
}) {
  const Link = link;
  const visit: ScreenReaderVisit = screenReaderVisit({
    locale,
    ...(publicRead !== undefined ? { public: publicRead } : {}),
    ...(release ? { release } : {}),
    ...(bounds ? { bounds } : {}),
    ...(reason ? { reason } : {}),
    ...(loading ? { loading } : {}),
    ...(publicRead?.subject.type ? { type: publicRead.subject.type } : {}),
  });
  const o = options(locale);
  if (publicRead && !isScreenType(publicRead.subject.type) && visit.state === 'invalid') return null;
  return (
    <article data-slot="screen-profile-reader" className="min-w-0 space-y-6">
      <header className="min-w-0 space-y-2">
        <ContentItemHeading id="screen-profile-reader-heading" tabIndex={-1} level={2} className="text-xl font-semibold">
          <span lang={visit.grain.lang ?? undefined}>{visit.grain.text}</span>
        </ContentItemHeading>
        <p className="text-muted-foreground">{m.screen_intro({}, o)}</p>
        {returnHref ? (
          <a className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`} href={returnHref}>
            {m.screen_visit_return({}, o)}
          </a>
        ) : null}
        {visit.type === 'schema:Movie' ? (
          <p className="text-sm text-muted-foreground">{m.screen_reader_episodes_unpublished({}, o)}</p>
        ) : null}
        <ProfileLibraryNote library={visit.library} locale={locale} kind="screen" />
      </header>
      {returnNotice ? <p role="status">{m.screen_visit_occurrence_missing({}, o)}</p> : null}
      {publicRead &&
      (visit.type === 'schema:TVSeries' || visit.type === 'schema:TVSeason') &&
      !visit.unpublished.episodes ? (
        <ScreenEpisodeList
          locale={locale}
          {...(release ? { release } : {})}
          {...(episodeRead ? { read: episodeRead } : {})}
          loading={episodeLoading}
          {...(onEpisodeRetry ? { retry: onEpisodeRetry } : {})}
          {...(episodeVisit ? { visit: episodeVisit } : {})}
          origin={episodeOrigin ?? { pathname: '', searchStr: '' }}
          readerSpoilerLevel={readerSpoilerLevel}
          {...(episodeVisitKey ? { visitKey: episodeVisitKey } : {})}
          link={link}
        />
      ) : null}
      {(visit.type === 'schema:TVSeason' || visit.type === 'schema:Episode') &&
      episodeVisit?.returnHref &&
      episodeVisit.returnMembershipId ? (
        <span
          onClickCapture={(event) =>
            episodeVisit.onReturnNavigate(
              episodeVisit.returnHref!,
              episodeVisit.returnMembershipId!,
              event as unknown as MouseEvent<HTMLAnchorElement>,
            )
          }
        >
          <Link href={episodeVisit.returnHref} className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}>
            {m.screen_episode_reader_return({}, o)}
          </Link>
        </span>
      ) : null}
      {visit.state !== 'ready' && visit.state !== 'empty' ? (
        <p role={visit.state === 'loading' ? 'status' : 'alert'}>{screenStateCopy(visit.state, locale)}</p>
      ) : null}
      {visit.state === 'empty' ? <p role="status">{screenStateCopy('empty', locale)}</p> : null}
      {onRetry && visit.state !== 'ready' && visit.state !== 'loading' ? (
        <button type="button" className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`} onClick={onRetry}>
          {m.correction_retry({}, o)}
        </button>
      ) : null}
      {publicRead && release && visit.state === 'ready' ? (
        <>
          {visit.groups.map((group) => (
            <section key={group.id} data-slot={`profile-group-${group.id}`} className="min-w-0 space-y-3">
              <ContentItemHeading level={2} className="text-xl font-semibold">{titles(group.id, locale)}</ContentItemHeading>
              {group.fields.map((field) => (
                <div key={field.property} className="min-w-0 space-y-3">
                  {field.values.map((value) => {
                    const occurrence = { holder: publicRead.subject.id, property: field.property, statement: value.id };
                    const statement = statementOf(publicRead, occurrence);
                    return statement ? (
                      <ScreenOccurrence
                        key={statement.id}
                        statement={statement}
                        property={field.property}
                        read={publicRead}
                        release={release}
                        locale={locale}
                        readerSpoilerLevel={readerSpoilerLevel}
                        {...(currentVisit ? { visit: currentVisit } : {})}
                        {...(inspection?.statement === statement.id
                          ? { targetId: screenCurrentInspectionId(statement.id) }
                          : {})}
                        identity={visitIdentity}
                      />
                    ) : null;
                  })}
                </div>
              ))}
            </section>
          ))}
          {inspection ? (
            <ScreenCurrentEvidence
              publicRead={publicRead}
              release={release}
              inspection={inspection}
              locale={locale}
              readerSpoilerLevel={readerSpoilerLevel}
              identity={visitIdentity}
              {...(!currentVisit ? { targetId: screenCurrentInspectionId(inspection.statement) } : {})}
            />
          ) : null}
        </>
      ) : null}
      <ProfileBoundNotes bounds={visit.bounds} locale={locale} />
      <ProfileSourceList sources={visit.sources} locale={locale} />
      {unsupportedCorrection ? (
        <section className="min-w-0 space-y-3" data-slot="screen-correction-unsupported">
          <p role="status">{m.screen_visit_unsupported({}, o)}</p>
          {globalHref ? (
            <a className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`} href={globalHref}>
              {m.screen_visit_global({}, o)}
            </a>
          ) : null}
        </section>
      ) : visit.correction && currentVisit ? (
        <div className="flex min-w-0 flex-wrap gap-3">
          <ScreenProfileEntry
            id={visit.correction.id}
            label={visit.grain.text}
            locale={locale}
            visit={currentVisit}
            targetId={screenCurrentEntryId(visit.correction.id)}
          />
        </div>
      ) : visit.correction ? (
        <p role="status">{m.release_fidelity_visit_unsupported({}, o)}</p>
      ) : null}
    </article>
  );
}

/** Ordinary Movie/TVSeries overview: composed public facts with the released screen grouping. */
export function ScreenProfileOverview({
  locale,
  public: publicRead,
  bounds,
  link = PlainLink,
  context,
  realm,
  viewerKey,
  readerSpoilerLevel = 0,
}: {
  locale: string;
  public: SubjectRead;
  bounds?: readonly ProfileBound[];
  link?: PageLink;
  context?: string;
  realm?: string;
  viewerKey?: string | null;
  readerSpoilerLevel?: number;
}) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const observationStore = browserObservation(queryClient);
  const observation = useSyncExternalStore(
    observationStore.subscribe,
    observationStore.getSnapshot,
    observationStore.getServerSnapshot,
  );
  const instance = useId();
  const observedSubject = useRef(publicRead.subject);
  const observationGeneration = useRef(0);
  if (observedSubject.current !== publicRead.subject) {
    observedSubject.current = publicRead.subject;
    observationGeneration.current += 1;
  }
  const cursorIntent = screenEpisodeCursorIntent(location.searchStr);
  const episodeCursor = cursorIntent.kind === 'cursor' ? cursorIntent.cursor : undefined;
  const realmKey = new URLSearchParams(location.searchStr).get('realm') ?? '';
  const selectedRealm = realm ?? realmKey;
  const origin: ScreenEpisodeOrigin = {
    pathname: location.pathname,
    searchStr: location.searchStr,
    hash: location.hash,
  };
  const fullAddress = `${origin.pathname}${origin.searchStr}${origin.hash ?? ''}`;
  const routeVisit = useRef({ address: fullAddress, generation: 0 });
  if (routeVisit.current.address !== fullAddress) {
    routeVisit.current = { address: fullAddress, generation: routeVisit.current.generation + 1 };
  }
  const routeGeneration = routeVisit.current.generation;
  const profileSourceKey = JSON.stringify([
    publicRead.subject.id,
    publicRead.subject.type,
    publicRead.subject.context,
    publicRead.subject.release,
    context ?? '',
    screenEpisodeReadingAddress(origin),
    selectedRealm,
    viewerKey ?? '',
    locale,
    readerSpoilerLevel,
    screenCurrentReturnValue(location.searchStr),
    observation.state,
    observation.state === 'signed-in'
      ? [observation.observation.subject, observation.observation.id]
      : observation.state,
    observationGeneration.current,
  ]);
  const pageKey = JSON.stringify([profileSourceKey, fullAddress, routeGeneration]);
  const observationCurrent = () => observationStore.getSnapshot() === observation;
  const query = useQuery({
    queryKey: ['screen-profile-reader', instance, profileSourceKey, pageKey, cursorIntent.kind, episodeCursor ?? ''],
    queryFn: async (): Promise<ScreenProfileReaderLoad> => {
      if (cursorIntent.kind === 'invalid') {
        const profile = await loadScreenProfileFactsForReader({
          data: { id: publicRead.subject.id, ...(context ? { context } : {}) },
        });
        return { profile, episodes: { ok: false, reason: 'stale' } };
      }
      return loadScreenProfileForReader({
        data: {
          id: publicRead.subject.id,
          expectedType: publicRead.subject.type,
          locale,
          ...(context ? { context } : {}),
          ...(episodeCursor !== undefined ? { cursor: episodeCursor } : {}),
        },
      });
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const loadedProfile = query.data?.profile;
  const profile = !query.isFetching && !query.isError ? loadedProfile : undefined;
  const release = profile?.ok ? profile.release : undefined;
  const currentPublic = profile?.ok && profile.public ? profile.public : undefined;
  const currentDefinition = currentPublic?.subject.release;
  const sourceAddress = screenCurrentSourceAddress(
    location.pathname,
    location.searchStr,
    location.hash,
    locale,
    publicRead.subject.id,
  );
  const currentVisitCandidate: ScreenCurrentVisit | undefined =
    currentPublic &&
    release &&
    currentPublic.subject.id === publicRead.subject.id &&
    currentPublic.subject.type === publicRead.subject.type &&
    currentPublic.subject.context === (context ?? publicRead.subject.context) &&
    currentDefinition === publicRead.subject.release &&
    releaseDigest(release) === currentDefinition &&
    sourceAddress &&
    (currentPublic.subject.context === candidateContext || !!selectedRealm) &&
    (!selectedRealm || selectedRealm === realmKey)
      ? {
          version: 1,
          subject: currentPublic.subject.id,
          type: currentPublic.subject.type as ScreenCurrentVisit['type'],
          context: currentPublic.subject.context,
          ...(selectedRealm ? { realm: selectedRealm } : {}),
          locale,
          definition: currentDefinition,
          source: sourceAddress,
        }
      : undefined;
  const currentVisitEntry = currentPublic
    ? catalogueEntries.screen({
        id: currentPublic.subject.id,
        label: pickText(currentPublic.subject.labels, locale).text,
        locale,
      }).href
    : '';
  const currentVisit =
    currentVisitCandidate && screenCurrentVisitAvailable(currentVisitEntry, currentVisitCandidate)
      ? currentVisitCandidate
      : undefined;
  const returnSearch = screenCurrentReturnValue(location.searchStr);
  const returnVisit: ScreenCurrentReturn | undefined = returnSearch.kind === 'current' ? returnSearch.visit : undefined;
  const returnMatches = !!(
    returnVisit &&
    currentPublic &&
    release &&
    returnVisit.subject === currentPublic.subject.id &&
    returnVisit.type === currentPublic.subject.type &&
    returnVisit.context === currentPublic.subject.context &&
    (returnVisit.realm ?? '') === selectedRealm &&
    returnVisit.locale === locale &&
    returnVisit.definition === currentDefinition &&
    releaseDigest(release) === currentDefinition
  );
  const returnInspection = returnMatches ? returnVisit?.occurrence : undefined;
  const returnNotice = returnSearch.kind === 'invalid' || (returnSearch.kind === 'current' && !returnMatches);
  const returnFocusKey = JSON.stringify([
    profileSourceKey,
    returnSearch,
    observationGeneration.current,
    observation.state,
    observation.state === 'signed-in' ? observation.observation.id : '',
  ]);
  const returnFocusCancelled = useRef(false);
  const returnFocusBinding = useRef<string | undefined>(undefined);
  if (returnSearch.kind !== 'none') {
    if (returnFocusBinding.current === undefined) returnFocusBinding.current = returnFocusKey;
    else if (returnFocusBinding.current !== returnFocusKey) returnFocusCancelled.current = true;
  }
  useLayoutEffect(() => {
    if (returnSearch.kind === 'none' || cursorIntent.kind === 'invalid') return;
    const cancel = () => {
      returnFocusCancelled.current = true;
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('pointermove', cancel, true);
    document.addEventListener('focusin', cancel, true);
    document.addEventListener('keydown', cancel, true);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('pointermove', cancel, true);
      document.removeEventListener('focusin', cancel, true);
      document.removeEventListener('keydown', cancel, true);
    };
  }, [returnFocusKey, returnSearch.kind, cursorIntent.kind]);
  useLayoutEffect(() => {
    if (!returnVisit || !returnMatches || query.isFetching || query.isPending || returnFocusCancelled.current) return;
    const params = new URLSearchParams(location.searchStr);
    if (params.has('screenSelection') || params.has('via')) return;
    const occurrence = returnVisit.occurrence && currentPublic ? statementOf(currentPublic, returnVisit.occurrence) : undefined;
    const visibleOccurrence = occurrence && spoilerLevel(occurrence) <= readerSpoilerLevel ? occurrence : undefined;
    const target = document.getElementById(
      visibleOccurrence ? screenCurrentInspectionId(visibleOccurrence.id) : screenCurrentEntryId(publicRead.subject.id),
    ) ?? document.getElementById('screen-profile-reader-heading');
    if (!target?.isConnected || document.activeElement !== document.body) return;
    returnFocusCancelled.current = true;
    target.focus();
  }, [returnFocusKey, returnVisit, returnMatches, query.isFetching, query.isPending, currentPublic, publicRead.subject.id, readerSpoilerLevel, location.searchStr]);
  const reason = profile && !profile.ok ? profile.reason : query.isError ? 'unavailable' : undefined;
  const episodeRead: ScreenEpisodeRead | undefined =
    cursorIntent.kind === 'invalid'
      ? { ok: false, reason: 'stale' }
      : (query.data?.episodes ?? (query.isError ? { ok: false, reason: 'unavailable' } : undefined));
  const episodeSourceKey = JSON.stringify([profileSourceKey, release ? releaseDigest(release) : '']);
  const settledKey = JSON.stringify([query.dataUpdatedAt, query.errorUpdatedAt, query.fetchStatus, query.failureCount]);
  const directReturn = screenEpisodeReturn(location.searchStr, locale);
  const episodeVisit = useScreenEpisodeVisit({
    sourceKey: episodeSourceKey,
    pageKey,
    origin,
    locale,
    observation,
    observationCurrent,
    ...(episodeRead ? { read: episodeRead } : {}),
    loading: query.isPending || query.isFetching,
    settledKey,
    ...(directReturn ? { directReturn } : {}),
  });
  return (
    <ScreenProfileReader
      locale={locale}
      public={currentPublic ?? (profile?.ok ? publicRead : null)}
      {...(release ? { release } : {})}
      {...(bounds ? { bounds } : {})}
      {...(reason ? { reason } : {})}
      {...(query.isPending || query.isFetching ? { loading: true } : {})}
      onRetry={() => void query.refetch()}
      {...(episodeRead ? { episodeRead } : {})}
      {...(query.isPending || query.isFetching ? { episodeLoading: true } : {})}
      onEpisodeRetry={() => void query.refetch()}
      episodeOrigin={{ pathname: location.pathname, searchStr: location.searchStr, hash: location.hash }}
      readerSpoilerLevel={readerSpoilerLevel}
      episodeVisitKey={`${episodeSourceKey}:${pageKey}:${settledKey}`}
      episodeVisit={episodeVisit}
      link={link}
      {...(currentVisit ? { currentVisit } : {})}
      {...(returnInspection ? { inspection: returnInspection } : {})}
      visitIdentity={profileSourceKey}
      returnNotice={returnNotice}
    />
  );
}
