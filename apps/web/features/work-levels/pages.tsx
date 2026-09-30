import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { idOf, iriOf } from '../work-page/route.ts';
import { ConnectionsSection, type Franchise } from './connections.tsx';
import { EditionsSection } from './editions.tsx';
import { copyOf } from './messages.ts';
import { PartsSection } from './parts.tsx';
import { REALIZATIONS_SHOWN, ReleaseFailure, ReleaseView } from './release-page.tsx';
import { franchisesOf } from './relation-rows.ts';
import { namesOf, readCollectionMembers, readParts, readRealization, readRealizations, readRelease, readReleases,
  readReleaseWork, readRelations, readWholes } from './read.ts';
import type { ConnectionsQuery, EditionsQuery } from './route.ts';
import type { CollectionMembers, Loaded, PartsPage, Summary } from './types.ts';

// Server compositions for the Work-level routes. Each read is Main's; the page
// only decides which reads a URL asks for, and in what bounds.

/** Franchises expanded on one page, members read per franchise, and member parts read in all at the parts grain. */
export const FRANCHISE_BOUNDS = { franchises: 3, members: 12, memberParts: 12, partsPerMember: 12 } as const;

/** The Work's own parts, its wholes, its relations and the franchises that contain it. */
async function franchisesFor(summaries: readonly Summary[], query: ConnectionsQuery): Promise<Franchise[]> {
  const chosen = summaries.filter(item => item.status === 'available' && item.type === 'collection')
    .slice(0, FRANCHISE_BOUNDS.franchises);
  const members = await Promise.all(chosen.map(summary => readCollectionMembers(summary.reference.slice(-36), {
    limit: FRANCHISE_BOUNDS.members,
    after: query.franchise === summary.reference.slice(-36) ? query.membersAfter : undefined })));
  let budget = FRANCHISE_BOUNDS.memberParts;
  const franchises: Franchise[] = [];
  for (const [index, summary] of chosen.entries()) {
    const read: Loaded<CollectionMembers> = members[index]!;
    const parts = new Map<string, Loaded<PartsPage>>();
    if (query.grain === 'parts' && read.ok) {
      const targets = read.data.members.flatMap(member => member.target ? [member.target] : []).slice(0, budget);
      budget -= targets.length;
      await Promise.all(targets.map(async target => parts.set(target,
        await readParts(target.slice(-36), { limit: FRANCHISE_BOUNDS.partsPerMember }))));
    }
    franchises.push({ collection: summary, members: read, parts });
  }
  return franchises;
}

export async function ConnectionsPage({ workRef, id, query, locale, pageMessages }: {
  workRef: string; id: string; query: ConnectionsQuery; locale: UiLocale; pageMessages: WorkPageMessages;
}) {
  const t = copyOf(locale);
  const [parts, wholes, relations] = await Promise.all([
    readParts(id, { parent: query.parent, after: query.partsAfter, limit: 50 }), readWholes(id),
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

export async function EditionsPage({ workRef, id, query, locale, pageMessages }: {
  workRef: string; id: string; query: EditionsQuery; locale: UiLocale; pageMessages: WorkPageMessages;
}) {
  const t = copyOf(locale);
  const [realizations, releases] = await Promise.all([readRealizations(id, query.realizationsAfter),
    readReleases(id, query.releasesAfter)]);
  const references = [
    ...(realizations.ok ? realizations.data.items.flatMap(item => [...item.translators, ...item.publishers]) : []),
    ...(releases.ok ? releases.data.items.flatMap(item => item.coverage.map(entry => entry.work)) : []),
  ];
  return <EditionsSection realizations={realizations} releases={releases} names={await namesOf(references)}
    workRef={workRef} query={query} locale={locale} t={t} pageMessages={pageMessages} />;
}

/** A release's page: Main's release, the realizations it carries, and the names of everything it reaches. */
export async function ReleasePage({ id, locale, pageMessages }: { id: string; locale: UiLocale; pageMessages: WorkPageMessages }) {
  const t = copyOf(locale);
  const owner = await readReleaseWork(id);
  const release = owner.ok ? await readRelease(owner.data.work, iriOf(id).slice(-36)) : owner;
  if (!release.ok) return <ReleaseFailure failure={release.failure} messages={pageMessages} t={t} />;
  const entries = release.data.coverage.filter(entry => entry.realization).slice(0, REALIZATIONS_SHOWN);
  const realizations = new Map(await Promise.all(entries.map(async entry => [entry.realization!,
    await readRealization(idOf(entry.work) ?? entry.work, idOf(entry.realization!) ?? entry.realization!)] as const)));
  const parties = [...realizations.values()].flatMap(read => (read.ok ? [...read.data.translators, ...read.data.publishers] : []));
  const names = await namesOf([...release.data.coverage.flatMap(entry => [entry.work, entry.mainVersion]), ...parties]);
  return <ReleaseView release={release.data} realizations={realizations} names={names} locale={locale} t={t} />;
}
