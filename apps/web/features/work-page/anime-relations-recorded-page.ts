import type { MainClient } from '../discover/types.ts';
import { publicVocabularyLabel } from '@rezics/model';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { PREVIEW_COUNTS } from '../work-levels/previews.tsx';
import type { Franchise } from '../work-levels/connections.tsx';
import { agentsOf, franchisesOf, relationRows } from '../work-levels/relation-rows.ts';
import type { ConnectionsQuery } from '../work-levels/route.ts';
import type { CollectionMember, CollectionMembers, Loaded, Names, NameSummary, PartsPage, People, RelationEntry, Summary } from '../work-levels/types.ts';
import { readWorkParts, readWorkWholes, readWorkRelations } from './anime-hub-recorded-page.ts';
import { settle } from './books-edition-page.read.ts';
import { iriOf, mainScope, type WorkScope } from './route.ts';
import type { Loaded as WorkLoaded, RatingContextPage, RatingRead } from './types.ts';

type Host = { main: MainClient; actingSubject?: string; signedIn?: boolean };

/** Client boundary shared by the production connections readers and recorded visits. */
export function animeRelationsReads({ main, actingSubject }: Host) {
  const readNames = async (resources: string, position?: string): Promise<Names> => {
    const refs = [...new Set(resources.split(' ').filter(Boolean))];
    const names = new Map<string, NameSummary>();
    const unresolved = refs.filter(reference => {
      const name = publicVocabularyLabel(reference);
      if (!name) return true;
      names.set(reference, { reference, status: 'public-term', name });
      return false;
    });
    for (let offset = 0; offset < unresolved.length; offset += 64) {
      const answer = await settle(() => main.v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
        resources: unresolved.slice(offset, offset + 64), ...(position ? { position } : {}),
        ...(actingSubject ? { actingSubject } : {}) }));
      const batch = unresolved.slice(offset, offset + 64);
      // A failed or partial batch cannot say that nobody has named these resources.
      for (const reference of batch) names.set(reference, { reference, status: 'unavailable-read' });
      if (answer.ok) for (const summary of answer.data.summaries) {
        if (batch.includes(summary.reference)) names.set(summary.reference, summary);
      }
    }
    return names;
  };
  const readPeople = async (entries: readonly RelationEntry[]): Promise<People> => {
    const people = await Promise.all(agentsOf(relationRows(entries)).map(async agent => {
      const profile = await settle(() => main.v1.agents({ id: agent.slice(-36) }).get({ query: { actingSubject } }));
      return profile.ok ? [agent, { name: profile.data.displayName, handle: profile.data.handle }] as const : null;
    }));
    return new Map(people.flatMap(person => person ? [person] : []));
  };
  return {
    readParts: (id: string, query: { parent?: string; after?: string; limit?: number }) =>
      readWorkParts(main, actingSubject, id, query),
    readWholes: (id: string, query: { after?: string; limit?: number } = {}) =>
      readWorkWholes(main, actingSubject, id, query),
    readRelations: (id: string, query: { after?: string; limit?: number }) =>
      readWorkRelations(main, actingSubject, id, query),
    readNames,
    namesOf: (resources: readonly string[], position?: string) => readNames([...new Set(resources)].sort().join(' '), position),
    readPeople,
    readCollectionMembers: async (collection: string, query: { after?: string; limit?: number }): Promise<Loaded<CollectionMembers>> => {
      const page = await settle(() => main.v1.collections({ id: collection }).get({ query: {
        actingSubject, after: query.after, limit: query.limit } }), query.after);
      if (!page.ok) return page;
      const members = (page.data.occurrences as CollectionMember[]).filter(item => item.role === 'member' && item.target);
      return { ok: true, data: { collection: page.data.collection, members, next: page.data.next } };
    },
  };
}
export type AnimeRelationsReads = Omit<ReturnType<typeof animeRelationsReads>, 'readNames'>;

/**
 * The members a franchise's current page lists (Main's page, 12 at a time) and, at the parts grain,
 * the first page of each member's parts; a member with more parts links to its own page for them.
 */
export const FRANCHISE_PAGE = { members: 12, partsPerMember: 12 } as const;

async function franchisesFor(
  reads: AnimeRelationsReads,
  summaries: readonly Summary[],
  query: ConnectionsQuery,
): Promise<Franchise[]> {
  const chosen = summaries.filter(
    (item) => item.status === 'available' && item.type === 'collection',
  );
  return Promise.all(
    chosen.map(async (summary) => {
      const collection = summary.reference.slice(-36);
      const members = await reads.readCollectionMembers(collection, {
        limit: FRANCHISE_PAGE.members,
        after: query.franchise === collection ? query.membersAfter : undefined,
      });
      const parts = new Map<string, Loaded<PartsPage>>();
      if (query.grain === 'parts' && members.ok) {
        await Promise.all(
          members.data.members
            .flatMap((member) => (member.target ? [member.target] : []))
            .map(async (target) => {
              parts.set(
                target,
                await reads.readParts(target.slice(-36), { limit: FRANCHISE_PAGE.partsPerMember }),
              );
            }),
        );
      }
      return { collection: summary, members, parts };
    }),
  );
}

/** Independent regions preserve the successful sibling and Main's opaque continuations. */
export async function readAnimeRelationsConnections(reads: AnimeRelationsReads, id: string, query: ConnectionsQuery) {
  // Independent reads start their dependent reads immediately: an unavailable
  // sibling cannot consume the page budget needed to name a disclosed result.
  const [partResult, wholeResult, relationResult] = await Promise.all([
    reads.readParts(id, { parent: query.parent, after: query.partsAfter, limit: 50 }).then(
      async (parts) => ({
        parts,
        names: await reads.namesOf(parts.ok ? parts.data.parts.flatMap((part) => part.work ?? []) : []),
      }),
    ),
    reads.readWholes(id, { after: query.wholesAfter }).then(async (wholes) => ({
      wholes,
      names: await reads.namesOf(wholes.ok ? wholes.data.wholes.map((whole) => whole.work) : []),
    })),
    reads.readRelations(id, { after: query.relationsAfter, limit: 20 }).then(async (relations) => {
      const people = relations.ok ? reads.readPeople(relations.data.items) : undefined;
      const franchises = await franchisesFor(
        reads,
        relations.ok ? franchisesOf(relations.data.items) : [],
        query,
      );
      const references = franchises.flatMap((franchise) => [
        ...(franchise.members.ok
          ? franchise.members.data.members.flatMap((member) => member.target ?? [])
          : []),
        ...[...franchise.parts.values()].flatMap((read) =>
          read.ok ? read.data.parts.flatMap((part) => part.work ?? []) : [],
        ),
      ]);
      const names = await reads.namesOf(references);
      return { relations, franchises, names, people: await people };
    }),
  ]);
  const { parts } = partResult;
  const { wholes } = wholeResult;
  const { relations, franchises, people } = relationResult;
  const names = new Map([...partResult.names, ...wholeResult.names, ...relationResult.names]);
  return { parts, wholes, relations, franchises, people, names };
}
export type AnimeRelationsConnections = Awaited<ReturnType<typeof readAnimeRelationsConnections>>;

/** Select one unchanged visit. Repeated frame and panel reads share their exact recorded request. */
export function recordedAnimeRelationsVisit(record: AnswerRecord, persona: AnswerPersona, entry: number, loading = false) {
  const samples = record.personas[persona].filter(sample => sample.label.startsWith(`visit-${entry}-`));
  const header = samples.find(sample => sample.method === 'GET' && /^\/v1\/works\/[^/?]+(?:\?|$)/.test(sample.path));
  if (!header) throw new Error(`Missing ${record.row}/${persona}/visit-${entry} header`);
  const url = new URL(header.path, 'https://record.invalid');
  const id = url.pathname.split('/').at(-1)!;
  const actingSubject = url.searchParams.get('actingSubject') ?? undefined;
  const seen = new Set<string>();
  const selections: RecordedSelection[] = [];
  for (const sample of loading ? [header] : samples) {
    const path = new URL(sample.path, 'https://record.invalid');
    path.searchParams.sort();
    const key = JSON.stringify([sample.method, path.pathname + path.search, sample.body]);
    if (seen.has(key)) continue;
    seen.add(key);
    selections.push({ label: sample.label, state: loading ? 'loading' : sample.status >= 400 ? 'error'
      : sample.status === 202 ? 'pending' : 'populated' });
  }
  return { id, actingSubject, header, selections };
}

/** Frame reads use the same client boundary as the request-cached server readers. */
export async function readAnimeRelationsRatings({ main, actingSubject }: Host, id: string,
  scope: WorkScope, contextId?: string): Promise<WorkLoaded<RatingRead>> {
  const contexts = await settle<RatingContextPage>(() => main.v1.resources({ resource: id })['rating-contexts'].get({
    query: { actingSubject, ...mainScope(scope) } }));
  if (!contexts.ok) return contexts;
  const items = contexts.data.items;
  const context = items.find(item => item.context === (contextId && iriOf(contextId))) ?? items[0] ?? null;
  const summary = await settle(() => main.v1.resources({ resource: id }).ratings.get({
    query: { actingSubject, ...mainScope(scope), context: context?.context } }));
  return summary.ok ? { ok: true, data: { contexts: items, context, summary: summary.data } } : summary;
}
export function readAnimeRelationsStats({ main, actingSubject }: Host, id: string, context?: string) {
  return settle(() => main.v1.works({ id })['reader-stats'].get({ query: { actingSubject, context } }));
}

/** The hub preview and full connections view use their own production page sizes. */
export async function readAnimeRelationsPreview(reads: Pick<AnimeRelationsReads, 'readParts' | 'readWholes' | 'namesOf'>, id: string) {
  const [partResult, wholeResult] = await Promise.all([
    reads.readParts(id, { limit: PREVIEW_COUNTS.parts + 1 }).then(async parts => ({
      parts, names: await reads.namesOf(parts.ok ? parts.data.parts.flatMap(part => part.work ?? []) : []),
    })),
    reads.readWholes(id, { limit: PREVIEW_COUNTS.wholes }).then(async wholes => ({
      wholes, names: await reads.namesOf(wholes.ok ? wholes.data.wholes.map(whole => whole.work) : []),
    })),
  ]);
  return { parts: partResult.parts, wholes: wholeResult.wholes,
    names: new Map([...partResult.names, ...wholeResult.names]) };
}
