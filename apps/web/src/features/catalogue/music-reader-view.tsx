import { useQuery } from '@tanstack/react-query';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { CandidateValue } from '../pages/data';
import { linkClass, linkColor, PlainLink, type PageLink, type Stmt } from '../pages/shared';
import { loadAlbumProfile } from './album-profile-actions';
import { AlbumProfileEntry } from './album-profile-entry';
import {
  musicReaderVisit,
  type MusicReaderVisit,
  type ProfileBound,
  type ProfileField,
  type ProfileFieldValue,
  type ProfileGroup,
  type ProfileLibrary,
  type ProfileReaderState,
  type ProfileSourceRecord,
} from './music-reader';
import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';

function options(locale: string) {
  return { locale: locale as never };
}

function statementOf(read: SubjectRead, property: string, id: string): Stmt | undefined {
  const held = read.subject.statements[property];
  return Array.isArray(held) ? (held.find((statement) => statement.id === id) as Stmt | undefined) : undefined;
}

function groupTitle(id: string, locale: string) {
  const o = options(locale);
  return id === 'dates'
    ? m.album_facts({}, o)
    : id === 'details'
      ? m.music_reader_details({}, o)
      : id === 'credits'
        ? m.album_credits_parts({}, o)
        : id === 'classification'
          ? m.album_classification({}, o)
          : id === 'authored'
            ? m.album_summary({}, o)
            : m.music_reader_related({}, o);
}

function stateCopy(state: ProfileReaderState, locale: string, kind: 'music' | 'screen') {
  const o = options(locale);
  if (state === 'loading') return m.candidate_loading({}, o);
  if (state === 'denied') return kind === 'music' ? m.music_reader_denied({}, o) : m.screen_reader_denied({}, o);
  if (state === 'stale') return kind === 'music' ? m.music_reader_stale({}, o) : m.screen_reader_stale({}, o);
  if (state === 'empty') return kind === 'music' ? m.music_reader_empty({}, o) : m.screen_reader_empty({}, o);
  return kind === 'music' ? m.music_reader_unavailable({}, o) : m.screen_reader_unavailable({}, o);
}

function ValueNotes({ value, locale }: { value: ProfileFieldValue; locale: string }) {
  const o = options(locale);
  const notes = [
    value.creditedAs ? `${m.music_reader_credited_as({}, o)}: ${value.creditedAs}` : null,
    value.roleLabel ? `${m.music_reader_role({}, o)}: ${value.roleLabel}` : null,
    value.position ? `${m.music_reader_position({}, o)}: ${value.position}` : null,
    value.episodeNumber ? `${m.screen_reader_episode_number({}, o)}: ${value.episodeNumber}` : null,
    typeof value.precision === 'number' ? `${m.screen_reader_date_precision({}, o)}: ${value.precision}` : null,
  ].filter((note): note is string => !!note);
  return notes.length ? (
    <ul className="text-sm text-muted-foreground">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  ) : null;
}

function FieldList({
  field,
  read,
  locale,
  link,
}: {
  field: ProfileField;
  read: SubjectRead;
  locale: string;
  link: PageLink;
}) {
  const Link = link;
  return (
    <div className="min-w-0 space-y-2">
      <h3 lang={field.label.lang ?? undefined} className="text-sm font-medium text-muted-foreground">
        {field.label.text}
      </h3>
      {field.values.map((value) => {
        const statement = statementOf(read, field.property, value.id);
        return (
          <div key={value.id} className="min-w-0 space-y-1">
            {statement ? (
              <CandidateValue
                snak={statement}
                related={read.related}
                subject={read.subject.id}
                locale={locale}
                link={Link}
              />
            ) : value.targetId ? (
              <Link
                href={subjectHref({ id: value.targetId, label: value.targetLabel ?? '' }, locale).href}
                className={`${linkClass} ${linkColor} inline-flex min-h-11 min-w-11 max-w-full items-center [overflow-wrap:anywhere]`}
              >
                {value.targetLabel || m.subject_value_unlabelled({}, options(locale))}
              </Link>
            ) : (
              <p className="text-muted-foreground">
                {value.state === 'unknown'
                  ? m.subject_value_unknown({}, options(locale))
                  : value.state === 'none'
                    ? m.subject_value_none({}, options(locale))
                    : (value.text ?? m.candidate_value_unavailable({}, options(locale)))}
              </p>
            )}
            <ValueNotes value={value} locale={locale} />
          </div>
        );
      })}
    </div>
  );
}

export function ProfileSourceList({
  sources,
  locale,
}: {
  sources: readonly ProfileSourceRecord[];
  locale: string;
}) {
  const o = options(locale);
  return (
    <section data-slot="profile-source-evidence" className="min-w-0 space-y-3">
      <ContentItemHeading level={2} className="text-xl font-semibold">
        {m.music_reader_source_evidence({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.music_reader_source_editorial({}, o)}</p>
      {sources.length ? (
        <ul className="min-w-0 space-y-2">
          {sources.map((record) => (
            <li key={`${record.name}:${record.url}`} className="min-w-0 [overflow-wrap:anywhere]">
              {record.url.startsWith('https://') || record.url.startsWith('http://') ? (
                <a
                  href={record.url}
                  className={`${linkClass} ${linkColor} inline-flex min-h-11 min-w-11 max-w-full items-center`}
                >
                  {record.name}
                </a>
              ) : (
                <span>{record.name}</span>
              )}
              {record.attribution ? <p className="text-sm text-muted-foreground">{record.attribution}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{m.music_reader_source_unavailable({}, o)}</p>
      )}
    </section>
  );
}

export function ProfileBoundNotes({
  bounds,
  locale,
}: {
  bounds: readonly ProfileBound[];
  locale: string;
}) {
  const incomplete = bounds.filter((bound) => !bound.complete);
  if (!incomplete.length) return null;
  return (
    <ul data-slot="profile-bounded-relations" className="text-sm text-muted-foreground">
      {incomplete.map((bound) => (
        <li key={bound.property}>
          {m.profile_reader_page_incomplete({ label: bound.property }, options(locale))}
        </li>
      ))}
    </ul>
  );
}

export function ProfileLibraryNote({
  library,
  unpublished,
  locale,
  kind,
}: {
  library: ProfileLibrary;
  unpublished?: { library?: boolean };
  locale: string;
  kind: 'music' | 'screen';
}) {
  if (kind === 'music' || unpublished?.library || !library.admitted) {
    return (
      <p data-slot="profile-library" className="text-sm text-muted-foreground">
        {kind === 'music'
          ? m.music_reader_library_unpublished({}, options(locale))
          : m.screen_reader_library_unpublished({}, options(locale))}
      </p>
    );
  }
  return (
    <p data-slot="profile-library" className="text-sm text-muted-foreground">
      {m.screen_reader_library_admitted({}, options(locale))}
    </p>
  );
}

export function ProfileReaderGroups({
  groups,
  read,
  locale,
  link,
  titles,
}: {
  groups: readonly ProfileGroup[];
  read: SubjectRead;
  locale: string;
  link: PageLink;
  titles: (id: string) => string;
}) {
  return (
    <>
      {groups.map((group) => (
        <section key={group.id} data-slot={`profile-group-${group.id}`} className="min-w-0 space-y-3">
          <ContentItemHeading level={2} className="text-xl font-semibold">
            {titles(group.id)}
          </ContentItemHeading>
          {group.fields.map((field) => (
            <FieldList key={field.property} field={field} read={read} locale={locale} link={link} />
          ))}
        </section>
      ))}
    </>
  );
}

export function MusicAlbumReader({
  locale,
  release,
  public: publicRead,
  bounds,
  reason,
  loading,
  onRetry,
  link = PlainLink,
}: {
  locale: string;
  release?: Release;
  public?: SubjectRead | null;
  bounds?: readonly ProfileBound[];
  reason?: Exclude<ProfileReaderState, 'ready' | 'empty'>;
  loading?: boolean;
  onRetry?: () => void;
  link?: PageLink;
}) {
  const visit: MusicReaderVisit = musicReaderVisit({
    locale,
    ...(publicRead !== undefined ? { public: publicRead } : {}),
    ...(release ? { release } : {}),
    ...(bounds ? { bounds } : {}),
    ...(reason ? { reason } : {}),
    ...(loading ? { loading } : {}),
  });
  const o = options(locale);
  return (
    <article data-slot="music-album-reader" className="min-w-0 space-y-6">
      <header className="min-w-0 space-y-2">
        <ContentItemHeading level={2} className="text-xl font-semibold">
          <span lang={visit.grain.lang ?? undefined}>{visit.grain.text}</span>
        </ContentItemHeading>
        <p className="text-muted-foreground">{m.album_grain({}, o)}</p>
        <p className="text-sm text-muted-foreground">{m.music_reader_tracks_unpublished({}, o)}</p>
        <ProfileLibraryNote library={visit.library} unpublished={visit.unpublished} locale={locale} kind="music" />
      </header>
      {visit.state !== 'ready' && visit.state !== 'empty' ? (
        <p role={visit.state === 'loading' ? 'status' : 'alert'}>{stateCopy(visit.state, locale, 'music')}</p>
      ) : null}
      {visit.state === 'empty' ? <p role="status">{stateCopy('empty', locale, 'music')}</p> : null}
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
          titles={(id) => groupTitle(id, locale)}
        />
      ) : null}
      <ProfileBoundNotes bounds={visit.bounds} locale={locale} />
      <ProfileSourceList sources={visit.sources} locale={locale} />
      {visit.correction ? (
        <div className="flex min-w-0 flex-wrap gap-3">
          <AlbumProfileEntry id={visit.correction.id} label={visit.grain.text} locale={locale} />
        </div>
      ) : null}
    </article>
  );
}

/** Ordinary MusicAlbum overview: composed public facts with the released album grouping. */
export function MusicAlbumOverview({
  locale,
  public: publicRead,
  bounds,
  link = PlainLink,
}: {
  locale: string;
  public: SubjectRead;
  bounds?: readonly ProfileBound[];
  link?: PageLink;
}) {
  const query = useQuery({
    queryKey: ['music-album-reader', publicRead.subject.id, locale],
    queryFn: () => loadAlbumProfile({ data: publicRead.subject.id }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const release = query.data?.ok ? query.data.release : undefined;
  const reason =
    query.data && !query.data.ok ? query.data.reason : query.isError ? 'unavailable' : undefined;
  return (
    <MusicAlbumReader
      locale={locale}
      public={publicRead}
      {...(release ? { release } : {})}
      {...(bounds ? { bounds } : {})}
      {...(reason ? { reason } : {})}
      {...(query.isPending ? { loading: true } : {})}
      onRetry={() => void query.refetch()}
      link={link}
    />
  );
}
