import { cache } from 'react';
import { failureOf } from '../work-page/failure.ts';
import { reader, readReviewer } from '../work-page/read.ts';
import { iriOf } from '../work-page/route.ts';
import { agentsOf, relationRows } from './relation-rows.ts';
import type { CollectionMember, CollectionMembers, Loaded, Names, PartsPage, RealizationPage, Realization,
  People, RelationEntry, RelationsPage, Release, ReleasePage, Summary, WholesPage } from './types.ts';

// Server reads for the Work-level pages. Each returns a `Loaded` result instead
// of throwing, so one section's failure never takes down another. Main answers
// parts, wholes, relations and Collections only with a bearer token and an
// acting Agent, so a reader without one is told which step is missing rather
// than shown an empty list.

type Answer<T> = { data: T | null; error: { status: number } | null };

/** Main answers 409 when the graph moved during a read; a read that is not continuing a cursor starts again once. */
async function settle<T>(call: () => Promise<Answer<T>>, cursor?: string): Promise<Loaded<T>> {
  try {
    let { data, error } = await call();
    if (error?.status === 409 && !cursor) ({ data, error } = await call());
    if (error) return { ok: false, failure: failureOf(error.status) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/** The acting Agent a read needs, or the reason the reader has none. */
async function actor() {
  const current = await reader();
  return current.actingSubject
    ? { ...current, actingSubject: current.actingSubject, failure: null }
    : { ...current, failure: (current.signedIn ? 'identity' : 'sign-in') as 'identity' | 'sign-in' };
}

export async function readParts(id: string, query: { parent?: string; after?: string; limit?: number }):
  Promise<Loaded<PartsPage>> {
  const current = await actor();
  if (current.failure) return { ok: false, failure: current.failure };
  return settle(() => current.main.v1.resources({ resource: id }).parts.get({ query: { actingSubject: current.actingSubject,
    parent: query.parent ? iriOf(query.parent) : undefined, after: query.after, limit: query.limit } }), query.after);
}

export async function readWholes(id: string, query: { after?: string; limit?: number } = {}): Promise<Loaded<WholesPage>> {
  const current = await actor();
  if (current.failure) return { ok: false, failure: current.failure };
  return settle(() => current.main.v1.resources({ resource: id }).wholes.get({ query: {
    actingSubject: current.actingSubject, after: query.after, limit: query.limit ?? 20 } }), query.after);
}

export async function readRelations(id: string, query: { after?: string; limit?: number }):
  Promise<Loaded<RelationsPage>> {
  const current = await actor();
  if (current.failure) return { ok: false, failure: current.failure };
  return settle(() => current.main.v1.resources({ resource: id }).relations.get({ query: {
    actingSubject: current.actingSubject, after: query.after, limit: query.limit } }), query.after);
}

/** The members a franchise Collection places, in the order Main keeps them. */
export async function readCollectionMembers(collection: string, query: { after?: string; limit?: number }):
  Promise<Loaded<CollectionMembers>> {
  const current = await actor();
  if (current.failure) return { ok: false, failure: current.failure };
  const page = await settle(() => current.main.v1.collections({ id: collection }).get({ query: {
    actingSubject: current.actingSubject, after: query.after, limit: query.limit } }), query.after);
  if (!page.ok) return page;
  const members = (page.data.occurrences as CollectionMember[]).filter(item => item.role === 'member' && item.target);
  return { ok: true, data: { collection: page.data.collection, members, next: page.data.next } };
}

/** Names and availability for up to 64 resources per Main call; a failed batch leaves its resources unnamed. */
export const readNames = cache(async (resources: string): Promise<Names> => {
  const refs = [...new Set(resources.split(' ').filter(Boolean))];
  const { main, actingSubject } = await reader();
  const names = new Map<string, Summary>();
  for (let offset = 0; offset < refs.length; offset += 64) {
    const batch = refs.slice(offset, offset + 64);
    const answer = await settle(() => main.v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
      resources: batch, ...(actingSubject ? { actingSubject } : {}) }));
    if (answer.ok) for (const summary of answer.data.summaries) names.set(summary.reference, summary);
  }
  return names;
});

/** `readNames` over a list; the cache key is the sorted, joined list so one request shares one call. */
export const namesOf = (resources: readonly string[]) => readNames([...new Set(resources)].sort().join(' '));

export async function readReleases(id: string, after?: string): Promise<Loaded<ReleasePage>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).releases.get({ query: { actingSubject, limit: 20, cursor: after } }), after);
}

export async function readRealizations(id: string, after?: string): Promise<Loaded<RealizationPage>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).realizations.get({ query: { actingSubject, limit: 20, cursor: after } }), after);
}

export async function readRealization(work: string, realization: string): Promise<Loaded<Realization>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id: work }).realizations({ realization }).get({ query: { actingSubject } }));
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
export async function readPeople(entries: readonly RelationEntry[]): Promise<People> {
  const found = await Promise.all(agentsOf(relationRows(entries)).map(async agent => [agent, await readReviewer(agent)] as const));
  return new Map(found.flatMap(([agent, person]) => (person ? [[agent, person] as const] : [])));
}
