import { useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
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
import { loadScreenProfileForReader } from './screen-episode-reader/actions';
import { screenEpisodeCursor, type ScreenEpisodeOrigin } from './screen-episode-reader/navigation';
import { ScreenEpisodeList } from './screen-episode-reader/view';
import type { ScreenEpisodeRead } from './screen-episode-reader/read';
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
      {publicRead && !visit.unpublished.episodes ? (
        <ScreenEpisodeList
          locale={locale}
          {...(release ? { release } : {})}
          {...(episodeRead ? { read: episodeRead } : {})}
          loading={episodeLoading}
          {...(onEpisodeRetry ? { retry: onEpisodeRetry } : {})}
          origin={episodeOrigin ?? { pathname: '', searchStr: '' }}
          readerSpoilerLevel={readerSpoilerLevel}
          {...(episodeVisitKey ? { visitKey: episodeVisitKey } : {})}
          link={link}
        />
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
  const instance = useId();
  const observedSubject = useRef(publicRead.subject);
  const observationGeneration = useRef(0);
  if (observedSubject.current !== publicRead.subject) {
    observedSubject.current = publicRead.subject;
    observationGeneration.current += 1;
  }
  const episodeCursor = screenEpisodeCursor(location.searchStr);
  const realmKey = new URLSearchParams(location.searchStr).get('realm') ?? '';
  const query = useQuery({
    queryKey: [
      'screen-profile-reader',
      instance,
      publicRead.subject.id,
      publicRead.subject.type,
      publicRead.subject.context,
      context ?? '',
      realmKey,
      viewerKey ?? '',
      locale,
      episodeCursor ?? '',
      readerSpoilerLevel,
      observationGeneration.current,
    ],
    queryFn: () =>
      loadScreenProfileForReader({
        data: {
          id: publicRead.subject.id,
          expectedType: publicRead.subject.type,
          locale,
          ...(context ? { context } : {}),
          ...(episodeCursor !== undefined ? { cursor: episodeCursor } : {}),
        },
      }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const profile = query.data?.profile;
  const release = profile?.ok ? profile.release : undefined;
  const reason = profile && !profile.ok ? profile.reason : query.isError ? 'unavailable' : undefined;
  const episodeRead = query.data?.episodes;
  const [episodeRetryRead, setEpisodeRetryRead] = useState<{ visitKey: string; read: ScreenEpisodeRead }>();
  const [retryingVisitKey, setRetryingVisitKey] = useState<string>();
  const retryToken = useRef(0);
  const episodeVisitKey = [
    publicRead.subject.id,
    publicRead.subject.type,
    publicRead.subject.context,
    context ?? '',
    realmKey,
    viewerKey ?? '',
    locale,
    readerSpoilerLevel,
    episodeCursor ?? '',
    release ? releaseDigest(release) : '',
    query.dataUpdatedAt,
    observationGeneration.current,
  ].join(':');
  const currentVisitKey = useRef(episodeVisitKey);
  currentVisitKey.current = episodeVisitKey;
  const retryEpisodes = async () => {
    const token = ++retryToken.current;
    const visitKey = episodeVisitKey;
    setRetryingVisitKey(visitKey);
    if (!release) {
      void query.refetch();
      setRetryingVisitKey(undefined);
      return;
    }
    try {
      const result = await loadScreenProfileForReader({
        data: {
          id: publicRead.subject.id,
          expectedType: publicRead.subject.type,
          locale,
          ...(context ? { context } : {}),
          ...(episodeCursor !== undefined ? { cursor: episodeCursor } : {}),
        },
      });
      if (currentVisitKey.current !== visitKey || retryToken.current !== token) return;
      if (result.profile.ok && releaseDigest(result.profile.release) !== releaseDigest(release)) {
        setEpisodeRetryRead(undefined);
        void query.refetch();
        return;
      }
      setEpisodeRetryRead({
        visitKey,
        read: result.episodes ?? { ok: false, reason: 'unavailable' },
      });
    } catch {
      if (currentVisitKey.current === visitKey && retryToken.current === token)
        setEpisodeRetryRead({ visitKey, read: { ok: false, reason: 'unavailable' } });
    } finally {
      if (retryToken.current === token) setRetryingVisitKey(undefined);
    }
  };
  const currentEpisodeRead = episodeRetryRead?.visitKey === episodeVisitKey ? episodeRetryRead.read : episodeRead;
  return (
    <ScreenProfileReader
      locale={locale}
      public={publicRead}
      {...(release ? { release } : {})}
      {...(bounds ? { bounds } : {})}
      {...(reason ? { reason } : {})}
      {...(query.isPending ? { loading: true } : {})}
      onRetry={() => void query.refetch()}
      {...(currentEpisodeRead ? { episodeRead: currentEpisodeRead } : {})}
      {...(query.isPending || query.isFetching || retryingVisitKey === episodeVisitKey ? { episodeLoading: true } : {})}
      onEpisodeRetry={() => void retryEpisodes()}
      episodeOrigin={{ pathname: location.pathname, searchStr: location.searchStr, hash: location.hash }}
      readerSpoilerLevel={readerSpoilerLevel}
      episodeVisitKey={episodeVisitKey}
      link={link}
    />
  );
}
