import { readingAgent } from '../work-page/read.ts';
import type { WorkAt } from '../work-page/route.ts';
import { readAnimeRelationsConnections } from '../work-page/anime-relations-recorded-page.ts';
import { AnimeRelationsSections } from '../work-page/anime-relations-recorded-page.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { iriOf, workRefOf } from '../work-page/route.ts';
import { buttonVariants } from '@rezics/ui/button';
import Link from '../shell/localized-link.tsx';
import { EditEntry } from '../work-levels-edit/edit-entry.tsx';
import { EditionsSection, ReleaseCard } from './editions.tsx';
import { copyOf } from './messages.ts';
import { ReleaseFailure, ReleaseView } from './release-page.tsx';
import {
  namesOf,
  readCollectionMembers,
  readParts,
  readPeople,
  readFollowedRealizations,
  readReleaseRealizations,
  readRealizations,
  readRelease,
  readReleases,
  readReleaseWork,
  readRelations,
  readWholes,
} from './read.ts';
import type { ConnectionsQuery, EditionsQuery } from './route.ts';
import type { ReleasePage } from './types.ts';

const outline = buttonVariants({ variant: 'outline', size: 'sm' });

// Server compositions for the Work-level routes. Each read is Main's; the page
// only decides which reads a URL asks for, and in what bounds.

export { FRANCHISE_PAGE } from '../work-page/anime-relations-recorded-page.ts';

export async function ConnectionsPage({ workRef, id, query, locale, pageMessages }: {
  workRef: WorkAt; id: string; query: ConnectionsQuery; locale: UiLocale; pageMessages: WorkPageMessages;
}) {
  const view = await readAnimeRelationsConnections({
    readParts, readWholes, readRelations, namesOf, readPeople, readCollectionMembers,
  }, id, query);
  return <div className="grid gap-10">
    <EditEntry workRef={workRefOf(workRef)} id={id} section="parts" locale={locale} />
    <AnimeRelationsSections view={view} workRef={workRef} id={id} query={query}
      locale={locale} pageMessages={pageMessages} />
  </div>;
}

export async function EditionsPage({
  workRef,
  id,
  query,
  locale,
  pageMessages,
  edit = true,
}: {
  workRef: WorkAt;
  id: string;
  query: EditionsQuery;
  locale: UiLocale;
  pageMessages: WorkPageMessages;
  /** Whether to offer the edit link; the edit page itself lists the same records without it. */
  edit?: boolean;
}) {
  const t = copyOf(locale);
  const [realizations, releases] = await Promise.all([
    readRealizations(id, query.realizationsAfter),
    readReleases(id, query.releasesAfter),
  ]);
  const listed = realizations.ok ? realizations.data.items : [];
  const sourceReads = await readFollowedRealizations(listed);
  const sources = sourceReads.flatMap(item => item.read.ok ? [item.read.data] : []);
  const references = [
    ...[...listed, ...sources].flatMap((item) => [
      ...item.translators,
      ...item.publishers,
      ...(item.source.kind === 'main-version' ? [item.source.mainVersion] : []),
    ]),
    ...(releases.ok
      ? releases.data.items.flatMap((item) => item.coverage.map((entry) => entry.work))
      : []),
  ];
  return (
    <div className="grid gap-4">
      {edit ? <EditEntry workRef={workRefOf(workRef)} id={id} section="editions" locale={locale} /> : null}
      <EditionsSection
        realizations={realizations}
        sources={sources}
        sourceReads={sourceReads}
        releases={releases}
        names={await namesOf(references)}
        workRef={workRef}
        query={query}
        locale={locale}
        t={t}
        pageMessages={pageMessages}
      />
    </div>
  );
}

/** A release's page: Main's release, the realizations it carries, and the names of everything it reaches. */
export async function ReleasePage({
  id,
  locale,
  pageMessages,
}: {
  id: string;
  locale: UiLocale;
  pageMessages: WorkPageMessages;
}) {
  const t = copyOf(locale);
  const owner = await readReleaseWork(id);
  const release = owner.ok ? await readRelease(owner.data.work, iriOf(id).slice(-36)) : owner;
  if (!release.ok)
    return <ReleaseFailure failure={release.failure} messages={pageMessages} t={t} />;
  // Every coverage entry's realization is read (a release covers at most 64).
  const realizations = await readReleaseRealizations(release.data.coverage);
  const loaded = [...realizations.values()].flatMap((read) => (read.ok ? [read.data] : []));
  const sourceReads = await readFollowedRealizations(loaded);
  const sources = sourceReads.flatMap(item => item.read.ok ? [item.read.data] : []);
  const parties = [...loaded, ...sources].flatMap((item) => [
    ...item.translators,
    ...item.publishers,
    ...(item.source.kind === 'main-version' ? [item.source.mainVersion] : []),
  ]);
  const names = await namesOf([
    ...release.data.coverage.flatMap((entry) => [entry.work, entry.mainVersion]),
    ...parties,
  ]);
  return (
    <ReleaseView
      release={release.data}
      reader={await readingAgent()}
      realizations={realizations}
      sources={sources}
      sourceReads={sourceReads}
      names={names}
      locale={locale}
      t={t}
    />
  );
}

/** Several releases carry one ISBN (or Main has more to give): the reader chooses, none is picked for them. */
export async function IsbnReleases({
  isbn,
  releases,
  cursor,
  locale,
}: {
  isbn: string;
  releases: ReleasePage;
  cursor: boolean;
  locale: UiLocale;
}) {
  const t = copyOf(locale);
  const names = await namesOf(
    releases.items.flatMap((item) => item.coverage.map((entry) => entry.work)),
  );
  return (
    <div className="grid gap-6">
      <h1 className="font-semibold text-3xl tracking-tight">
        {t.isbnMatches} <span className="font-mono text-xl">{isbn}</span>
      </h1>
      <div className="grid gap-5">
        {releases.items.map((release) => (
          <ReleaseCard
            key={release.id}
            release={release}
            names={names}
            locale={locale}
            t={t}
            headingLevel={2}
          />
        ))}
      </div>
      {releases.nextCursor || cursor ? (
        <nav aria-label={t.releasesPages} className="flex flex-wrap justify-between gap-2">
          {cursor ? (
            <Link href={`/isbn/${isbn}`} className={outline}>
              {t.firstPage}
            </Link>
          ) : (
            <span />
          )}
          {releases.nextCursor ? (
            <Link
              href={`/isbn/${isbn}?cursor=${encodeURIComponent(releases.nextCursor)}`}
              className={outline}
            >
              {t.showMore}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
