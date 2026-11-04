import { useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useId, useRef } from 'react';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { m } from '../../paraglide/messages.js';
import { PlainLink, type PageLink } from '../pages/shared';
import { ScreenProfileEntry } from './screen-profile-entry';
import { isScreenType, screenReaderVisit, type ScreenReaderVisit } from './screen-profile';
import { screenGroupLabel } from './screen-profile-fields';
import type { ScreenGroup } from './screen-profile';
import { loadScreenProfileForReader } from './screen-episode-reader/actions';
import { screenEpisodeCursor, screenEpisodeReturnHref, type ScreenEpisodeOrigin } from './screen-episode-reader/navigation';
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
  returnHref,
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
  returnHref?: string;
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
        {visit.type === 'schema:Episode' && returnHref ? (
          <div className="flex min-w-0 flex-wrap gap-3">
            <Link href={returnHref} className={`${actionClass} text-primary underline underline-offset-4`}>
              {m.screen_episode_reader_return({}, o)}
            </Link>
          </div>
        ) : null}
        <ProfileLibraryNote library={visit.library} locale={locale} kind="screen" />
      </header>
      {publicRead && !visit.unpublished.episodes ? (
        <ScreenEpisodeList
          locale={locale}
          read={episodeRead}
          loading={episodeLoading}
          retry={onEpisodeRetry}
          origin={episodeOrigin ?? { pathname: '', searchStr: '' }}
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
}: {
  locale: string;
  public: SubjectRead;
  bounds?: readonly ProfileBound[];
  link?: PageLink;
  context?: string;
  viewerKey?: string | null;
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
  const query = useQuery({
    queryKey: [
      'screen-profile-reader',
      instance,
      publicRead.subject.id,
      publicRead.subject.type,
      publicRead.subject.context,
      context ?? '',
      viewerKey ?? '',
      locale,
      episodeCursor ?? '',
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
  const returnHref =
    publicRead.subject.type === 'schema:Episode'
      ? screenEpisodeReturnHref(locale, location.searchStr)
      : undefined;
  return (
    <ScreenProfileReader
      locale={locale}
      public={publicRead}
      {...(release ? { release } : {})}
      {...(bounds ? { bounds } : {})}
      {...(reason ? { reason } : {})}
      {...(query.isPending ? { loading: true } : {})}
      onRetry={() => void query.refetch()}
      {...(episodeRead ? { episodeRead } : {})}
      {...(query.isPending ? { episodeLoading: true } : {})}
      onEpisodeRetry={() => void query.refetch()}
      episodeOrigin={{ pathname: location.pathname, searchStr: location.searchStr }}
      {...(returnHref ? { returnHref } : {})}
      link={link}
    />
  );
}
