import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { idOf, iriOf } from '../work-page/route.ts';
import { buttonVariants } from '@rezics/ui/button';
import Link from '../shell/localized-link.tsx';
import { ConnectionsSection, type Franchise } from './connections.tsx';
import { EditionsSection, ReleaseCard } from './editions.tsx';
import { copyOf } from './messages.ts';
import { PartsSection } from './parts.tsx';
import { ReleaseFailure, ReleaseView } from './release-page.tsx';
import { franchisesOf } from './relation-rows.ts';
import { namesOf, readCollectionMembers, readParts, readRealization, readRealizations, readRelease, readReleases,
  readReleaseWork, readRelations, readWholes } from './read.ts';
import type { ConnectionsQuery, EditionsQuery } from './route.ts';
import type { Loaded, PartsPage, Realization, ReleasePage, Summary } from './types.ts';

const outline = buttonVariants({ variant: 'outline', size: 'sm' });

// Server compositions for the Work-level routes. Each read is Main's; the page
// only decides which reads a URL asks for, and in what bounds.

/**
 * The members a franchise's current page lists (Main's page, 12 at a time) and, at the parts grain,
 * the first page of each member's parts; a member with more parts links to its own page for them.
 */
export const FRANCHISE_PAGE = { members: 12, partsPerMember: 12 } as const;

async function franchisesFor(summaries: readonly Summary[], query: ConnectionsQuery): Promise<Franchise[]> {
  const chosen = summaries.filter(item => item.status === 'available' && item.type === 'collection');
  return Promise.all(chosen.map(async summary => {
    const collection = summary.reference.slice(-36);
    const members = await readCollectionMembers(collection, { limit: FRANCHISE_PAGE.members,
      after: query.franchise === collection ? query.membersAfter : undefined });
    const parts = new Map<string, Loaded<PartsPage>>();
    if (query.grain === 'parts' && members.ok) {
      await Promise.all(members.data.members.flatMap(member => (member.target ? [member.target] : [])).map(async target => {
        parts.set(target, await readParts(target.slice(-36), { limit: FRANCHISE_PAGE.partsPerMember }));
      }));
    }
    return { collection: summary, members, parts };
  }));
}

export async function ConnectionsPage({ workRef, id, query, locale, pageMessages }: {
  workRef: string; id: string; query: ConnectionsQuery; locale: UiLocale; pageMessages: WorkPageMessages;
}) {
  const t = copyOf(locale);
  const [parts, wholes, relations] = await Promise.all([
    readParts(id, { parent: query.parent, after: query.partsAfter, limit: 50 }), readWholes(id, { after: query.wholesAfter }),
    readRelations(id, { after: query.relationsAfter, limit: 20 })]);
  const franchises = await franchisesFor(relations.ok ? franchisesOf(relations.data.items) : [], query);
  const references = [
    ...(parts.ok ? parts.data.parts.flatMap(part => part.work ?? []) : []),
    ...(wholes.ok ? wholes.data.wholes.map(whole => whole.work) : []),
    ...franchises.flatMap(franchise => [
      ...(franchise.members.ok ? franchise.members.data.members.flatMap(member => member.target ?? []) : []),
      ...[...franchise.parts.values()].flatMap(read => (read.ok ? read.data.parts.flatMap(part => part.work ?? []) : []))]),
  ];
  const names = await namesOf(references);
  return <div className="grid gap-10">
    <PartsSection parts={parts} wholes={wholes} names={names} workRef={workRef} query={query} locale={locale} t={t}
      pageMessages={pageMessages} />
    <ConnectionsSection relations={relations} franchises={franchises} names={names} workRef={workRef} current={id}
      query={query} locale={locale} t={t} pageMessages={pageMessages} />
  </div>;
}

/** The realizations the loaded ones follow (translations of a text on another page), so each names its source language. */
async function followedBy(loaded: readonly Realization[], known: (realization: string) => boolean): Promise<Realization[]> {
  const followed = new Map(loaded.flatMap(item => (item.source.kind === 'realization' && !known(item.source.realization)
    ? [[item.source.realization, item.source.work] as const] : [])));
  return (await Promise.all([...followed].map(([realization, work]) =>
    readRealization(idOf(work) ?? work, idOf(realization) ?? realization)))).flatMap(read => (read.ok ? [read.data] : []));
}

export async function EditionsPage({ workRef, id, query, locale, pageMessages }: {
  workRef: string; id: string; query: EditionsQuery; locale: UiLocale; pageMessages: WorkPageMessages;
}) {
  const t = copyOf(locale);
  const [realizations, releases] = await Promise.all([readRealizations(id, query.realizationsAfter),
    readReleases(id, query.releasesAfter)]);
  const listed = realizations.ok ? realizations.data.items : [];
  const sources = await followedBy(listed, realization => listed.some(item => item.id === realization));
  const references = [
    ...[...listed, ...sources].flatMap(item => [...item.translators, ...item.publishers,
      ...(item.source.kind === 'main-version' ? [item.source.mainVersion] : [])]),
    ...(releases.ok ? releases.data.items.flatMap(item => item.coverage.map(entry => entry.work)) : []),
  ];
  return <EditionsSection realizations={realizations} sources={sources} releases={releases} names={await namesOf(references)}
    workRef={workRef} query={query} locale={locale} t={t} pageMessages={pageMessages} />;
}

/** A release's page: Main's release, the realizations it carries, and the names of everything it reaches. */
export async function ReleasePage({ id, locale, pageMessages }: { id: string; locale: UiLocale; pageMessages: WorkPageMessages }) {
  const t = copyOf(locale);
  const owner = await readReleaseWork(id);
  const release = owner.ok ? await readRelease(owner.data.work, iriOf(id).slice(-36)) : owner;
  if (!release.ok) return <ReleaseFailure failure={release.failure} messages={pageMessages} t={t} />;
  // Every coverage entry's realization is read (a release covers at most 64).
  const entries = release.data.coverage.filter(entry => entry.realization);
  const realizations = new Map(await Promise.all(entries.map(async entry => [entry.realization!,
    await readRealization(idOf(entry.work) ?? entry.work, idOf(entry.realization!) ?? entry.realization!)] as const)));
  const loaded = [...realizations.values()].flatMap(read => (read.ok ? [read.data] : []));
  const sources = await followedBy(loaded, realization => realizations.has(realization));
  const parties = [...loaded, ...sources].flatMap(item => [...item.translators, ...item.publishers,
    ...(item.source.kind === 'main-version' ? [item.source.mainVersion] : [])]);
  const names = await namesOf([...release.data.coverage.flatMap(entry => [entry.work, entry.mainVersion]), ...parties]);
  return <ReleaseView release={release.data} realizations={realizations} sources={sources} names={names} locale={locale} t={t} />;
}

/** Several releases carry one ISBN (or Main has more to give): the reader chooses, none is picked for them. */
export async function IsbnReleases({ isbn, releases, cursor, locale }: {
  isbn: string; releases: ReleasePage; cursor: boolean; locale: UiLocale;
}) {
  const t = copyOf(locale);
  const names = await namesOf(releases.items.flatMap(item => item.coverage.map(entry => entry.work)));
  return <div className="grid gap-6">
    <h1 className="font-semibold text-3xl tracking-tight">{t.isbnMatches} <span className="font-mono text-xl">{isbn}</span></h1>
    <div className="grid gap-5">{releases.items.map(release => <ReleaseCard key={release.id} release={release} names={names}
      locale={locale} t={t} headingLevel={2} />)}</div>
    {releases.nextCursor || cursor ? <nav aria-label={t.releasesPages} className="flex flex-wrap justify-between gap-2">
      {cursor ? <Link href={`/isbn/${isbn}`} className={outline}>{t.firstPage}</Link> : <span />}
      {releases.nextCursor ? <Link href={`/isbn/${isbn}?cursor=${encodeURIComponent(releases.nextCursor)}`}
        className={outline}>{t.showMore}</Link> : null}
    </nav> : null}
  </div>;
}
