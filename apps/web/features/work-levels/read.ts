import { cache } from 'react';
import { readWorkParts, readWorkRealizations, readWorkRelations, readWorkWholes } from '../work-page/anime-hub-recorded-page.ts';
import { settle } from '../work-page/books-edition-page.read.ts';
import { reader, type SuppliedClient } from '../work-page/read.ts';
import { animeRelationsReads } from '../work-page/anime-relations-recorded-page.ts';
import { idOf } from '../work-page/route.ts';
import type { CollectionMembers, Loaded, Names, PartsPage, RealizationPage, Realization,
  CollectionMember, People, RelationEntry, RelationsPage, Release, ReleasePage, Summary, WholesPage } from './types.ts';

export interface PublicCollectionPage {
  occurrences: readonly CollectionMember[];
  names: Names;
  nextCursor: string | null;
}

/** Main admits public and private membership, including groups and opaque continuation. */
export async function readPublicCollectionPage(id: string,
  query: { after?: string; parent?: string; position?: string }, client?: SuppliedClient): Promise<Loaded<PublicCollectionPage>> {
  const current = client ?? await reader();
  const read = await settle(() => current.main.v1.collections({ id }).get({ query: {
    ...query, actingSubject: current.actingSubject, limit: 20 } }), query.after);
  if (!read.ok) return read;
  const occurrences = read.data.occurrences as CollectionMember[];
  const resources = [...new Set(occurrences.flatMap(item => item.target ?? []))];
  const names = new Map<string, Summary>();
  if (resources.length) {
    const summaries = await settle(() => current.main.v1.resources.summaries.post({
      profile: 'resource-summary-batch-v1', resources, actingSubject: current.actingSubject,
      ...(query.position ? { position: query.position } : {}) }));
    if (!summaries.ok) return summaries;
    for (const summary of summaries.data.summaries) names.set(summary.reference, summary);
  }
  // The Collection owner calls its opaque cursor `next`; forward it without interpreting it.
  const cursor = read.data.next;
  return { ok: true, data: { occurrences, names, nextCursor: cursor } };
}

// Server reads for the Work-level pages. Each returns a `Loaded` result instead
// of throwing, so one section's failure never takes down another. Main decides
// disclosure for public parts, wholes, relations and Collection reads.

export async function readParts(id: string, query: { parent?: string; after?: string; limit?: number }, client?: SuppliedClient):
  Promise<Loaded<PartsPage>> {
  const current = client ?? await reader();
  return readWorkParts(current.main, current.actingSubject, id, query);
}

export async function readWholes(id: string, query: { after?: string; limit?: number } = {}, client?: SuppliedClient): Promise<Loaded<WholesPage>> {
  const current = client ?? await reader();
  return readWorkWholes(current.main, current.actingSubject, id, query);
}

export async function readRelations(id: string, query: { after?: string; limit?: number }, client?: SuppliedClient):
  Promise<Loaded<RelationsPage>> {
  const current = client ?? await reader();
  return readWorkRelations(current.main, current.actingSubject, id, query);
}

/** The members a franchise Collection places, in the order Main keeps them. */
export async function readCollectionMembers(collection: string, query: { after?: string; limit?: number }):
  Promise<Loaded<CollectionMembers>> {
  return animeRelationsReads(await reader()).readCollectionMembers(collection, query);
}

/**
 * Names and availability for up to 64 resources per Main call; a failed batch leaves its resources unnamed. `position` is
 * the reading position (`all` or an occurrence IRI) Main withholds later names for; omitted, Main chooses.
 */
export const readNames = cache(async (resources: string, position?: string, client?: SuppliedClient): Promise<Names> => {
  return animeRelationsReads(client ?? await reader()).readNames(resources, position);
});

/** `readNames` over a list; the cache key is the sorted, joined list and the position, so one request shares one call per position. */
export const namesOf = (resources: readonly string[], position?: string, client?: SuppliedClient) =>
  readNames([...new Set(resources)].sort().join(' '), position, client);

export async function readReleases(id: string, after?: string, client?: SuppliedClient): Promise<Loaded<ReleasePage>> {
  const { main, actingSubject } = client ?? await reader();
  return settle(() => main.v1.works({ id }).releases.get({ query: { actingSubject, limit: 20, cursor: after } }), after);
}

export async function readRealizations(id: string, after?: string, client?: SuppliedClient): Promise<Loaded<RealizationPage>> {
  const { main, actingSubject } = client ?? await reader();
  return readWorkRealizations(main, actingSubject, id, after);
}

export async function readRealization(work: string, realization: string, revision?: string, client?: SuppliedClient): Promise<Loaded<Realization>> {
  const { main, actingSubject } = client ?? await reader();
  return settle(() => main.v1.works({ id: work }).realizations({ realization }).get({ query: { actingSubject, revision } }));
}

/** A release selects a retained realization revision, independently of its current head. */
export async function readReleaseRealizations(coverage: Release['coverage'], client?: SuppliedClient):
  Promise<ReadonlyMap<string, Loaded<Realization>>> {
  return new Map(await Promise.all(coverage.flatMap(entry => entry.realization
    ? [readRealization(idOf(entry.work) ?? entry.work, idOf(entry.realization) ?? entry.realization,
      entry.revision ?? undefined, client).then(read => [entry.realization!, read] as const)] : [])));
}

export type SelectedRealizationRead = Pick<Realization, 'work' | 'id' | 'revision'> & { read: Loaded<Realization> };

/** Resolve only exact source revisions; retain a selected revision's refusal instead of substituting another head. */
export async function readFollowedRealizations(loaded: readonly Realization[], client?: SuppliedClient): Promise<SelectedRealizationRead[]> {
  const known = new Set(loaded.map(item => `${item.id}\0${item.revision}`));
  const followed = new Map(loaded.flatMap(item => item.source.kind === 'realization'
    && !known.has(`${item.source.realization}\0${item.source.revision}`)
    ? [[`${item.source.realization}\0${item.source.revision}`, item.source] as const] : []));
  return Promise.all([...followed.values()].map(async source => ({ work: source.work, id: source.realization,
    revision: source.revision, read: await readRealization(idOf(source.work) ?? source.work,
      idOf(source.realization) ?? source.realization, source.revision, client) })));
}

/** One release of a Work, by its own ID; the release's Work comes from its resource summary. */
export async function readRelease(work: string, release: string): Promise<Loaded<Release>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id: work }).releases({ release }).get({ query: { actingSubject } }));
}

/** Releases carrying an ISBN-13, as Main resolves it. */
export async function readReleasesByIsbn(isbn13: string, cursor?: string): Promise<Loaded<ReleasePage>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.releases.get({ query: { isbn13, actingSubject, cursor } }), cursor);
}

/** The Work a release belongs to, from the release's resource summary. */
export async function readReleaseWork(release: string): Promise<Loaded<{ work: string }>> {
  const { main, actingSubject } = await reader();
  const answer = await settle(() => main.v1.resources({ resource: release }).get({ query: { actingSubject } }));
  if (!answer.ok) return answer;
  const summary = answer.data as { type?: string; work?: string | null };
  return summary.type === 'release' && summary.work
    ? { ok: true, data: { work: summary.work.slice(-36) } } : { ok: false, failure: 'missing' };
}

/** The contributors a relation page names as REZICS Agents, with the name and handle their profile link needs; one Agent Main will not name stays a bare key. */
export async function readPeople(entries: readonly RelationEntry[], client?: SuppliedClient): Promise<People> {
  return animeRelationsReads(client ?? await reader()).readPeople(entries);
}
