import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useId, useRef, useSyncExternalStore, type MouseEvent } from 'react';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import type { SubjectRead } from '@rezics/client';
import { releaseDigest, type Release } from '@rezics/definitions';
import { m } from '../../paraglide/messages.js';
import { PlainLink, type PageLink } from '../pages/shared';
import { ScreenProfileEntry } from './screen-profile-entry';
import { isScreenType, screenReaderVisit, type ScreenReaderVisit } from './screen-profile';
import { screenGroupLabel } from './screen-profile-fields';
import type { ScreenGroup } from './screen-profile';
import { browserObservation } from '../../session/observation';
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
import { ProfileBoundNotes, ProfileLibraryNote, ProfileReaderGroups, ProfileSourceList } from './music-reader-view';
import type { ProfileBound, ProfileReaderState } from './music-reader';

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
        <ContentItemHeading level={2} className="text-xl font-semibold">
          <span lang={visit.grain.lang ?? undefined}>{visit.grain.text}</span>
        </ContentItemHeading>
        <p className="text-muted-foreground">{m.screen_intro({}, o)}</p>
        {visit.type === 'schema:Movie' ? (
          <p className="text-sm text-muted-foreground">{m.screen_reader_episodes_unpublished({}, o)}</p>
        ) : null}
        <ProfileLibraryNote library={visit.library} locale={locale} kind="screen" />
      </header>
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
      {publicRead && visit.state === 'ready' ? (
        <ProfileReaderGroups
          groups={visit.groups}
          read={publicRead}
          locale={locale}
          link={link}
          titles={(id) => titles(id, locale)}
        />
      ) : null}
      <ProfileBoundNotes bounds={visit.bounds} locale={locale} />
      <ProfileSourceList sources={visit.sources} locale={locale} />
      {visit.correction ? (
        <div className="flex min-w-0 flex-wrap gap-3">
          <ScreenProfileEntry id={visit.correction.id} label={visit.grain.text} locale={locale} />
        </div>
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
  viewerKey,
  readerSpoilerLevel = 0,
}: {
  locale: string;
  public: SubjectRead;
  bounds?: readonly ProfileBound[];
  link?: PageLink;
  context?: string;
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
    context ?? '',
    screenEpisodeReadingAddress(origin),
    realmKey,
    viewerKey ?? '',
    locale,
    readerSpoilerLevel,
    observation.state,
    observation.state === 'signed-in'
      ? [observation.observation.subject, observation.observation.id]
      : observation.state,
    observationGeneration.current,
  ]);
  const pageKey = JSON.stringify([profileSourceKey, fullAddress, routeGeneration]);
  const observationCurrent = () => observationStore.getSnapshot() === observation;
  const query = useQuery({
    queryKey: [
      'screen-profile-reader',
      instance,
      profileSourceKey,
      pageKey,
      cursorIntent.kind,
      episodeCursor ?? '',
    ],
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
  const lastGoodProfile = useRef<{ source: string; profile: typeof loadedProfile } | undefined>(undefined);
  if (lastGoodProfile.current?.source !== profileSourceKey) lastGoodProfile.current = undefined;
  if (loadedProfile?.ok) lastGoodProfile.current = { source: profileSourceKey, profile: loadedProfile };
  const profile = loadedProfile?.ok ? loadedProfile : lastGoodProfile.current?.profile ?? loadedProfile;
  const release = profile?.ok ? profile.release : undefined;
  const reason = profile && !profile.ok ? profile.reason : query.isError ? 'unavailable' : undefined;
  const episodeRead: ScreenEpisodeRead | undefined =
    cursorIntent.kind === 'invalid'
      ? { ok: false, reason: 'stale' }
      : query.data?.episodes ?? (query.isError ? { ok: false, reason: 'unavailable' } : undefined);
  const episodeSourceKey = JSON.stringify([
    profileSourceKey,
    release ? releaseDigest(release) : '',
  ]);
  const settledKey = JSON.stringify([
    query.dataUpdatedAt,
    query.errorUpdatedAt,
    query.fetchStatus,
    query.failureCount,
  ]);
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
    directReturn: screenEpisodeReturn(location.searchStr, locale),
  });
  return (
    <ScreenProfileReader
      locale={locale}
      public={publicRead}
      {...(release ? { release } : {})}
      {...(bounds ? { bounds } : {})}
      {...(reason ? { reason } : {})}
      {...(query.isPending && !lastGoodProfile.current?.profile?.ok ? { loading: true } : {})}
      onRetry={() => void query.refetch()}
      {...(episodeRead ? { episodeRead } : {})}
      {...(query.isPending || query.isFetching ? { episodeLoading: true } : {})}
      onEpisodeRetry={() => void query.refetch()}
      episodeOrigin={{ pathname: location.pathname, searchStr: location.searchStr, hash: location.hash }}
      readerSpoilerLevel={readerSpoilerLevel}
      episodeVisitKey={`${episodeSourceKey}:${pageKey}:${settledKey}`}
      episodeVisit={episodeVisit}
      link={link}
    />
  );
}
