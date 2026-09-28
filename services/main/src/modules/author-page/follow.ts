import type { Static } from 'typebox';
import { externalAuthorFollow, externalAuthorKey, type followTarget } from '../follows/contract.ts';
import { readAuthorNames, sourceReportedAuthorWorks } from '../source/author-name-read.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { publicWork, WorkReadInvalid, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { creditedPublicWorks } from './read.ts';

/**
 * A page of followed authors reads at most eight: one Source probe per Open
 * Library author (≤65 bound Works each, as the author page), then one graph
 * query naming each author's newest public Work. Jena groups every public
 * Work the eight credit; that scan is bounded by the Work read's shared
 * 160-call/4 MiB/10 s envelope, as the author page's enumeration is.
 */
export const FOLLOWED_AUTHORS_COST = { authors: 8 } as const;

/**
 * An Open Library author as a follow target: named as their page names them,
 * and public exactly while their page is, that is while a public Work on
 * REZICS credits them. One Source probe, one graph row and one name batch.
 */
export async function readExternalAuthorTarget(session: WorkReadSession, target: string):
  Promise<Static<typeof followTarget>> {
  if (session.principal) throw new WorkReadUnavailable('Public follow reader required');
  const key = externalAuthorKey(target);
  if (!key) throw new WorkReadInvalid('Invalid author follow target');
  const reported = await sourceReportedAuthorWorks(session, key);
  const rows = await session.query(`SELECT ?id WHERE {
    ${creditedPublicWorks([key], reported.works.map(work => [work, key] as const))} } LIMIT 1`, 1);
  if (!rows.length) throw new WorkReadMissing('Follow target is unavailable');
  const name = (await readAuthorNames(session, [key])).get(key);
  const id = key.slice('/authors/'.length);
  return { id: target, kind: 'external-author',
    name: { value: name?.displayName ?? id, language: 'und', direction: 'ltr', basis: 'fallback' },
    icon: { kind: 'fallback', policy: 'avatar-fallback-v1', key: target, resourceType: 'agent' },
    realm: null, href: `/authors/open-library/${id}` };
}

/**
 * Each author's newest public, top-level Work on REZICS, by the Work's
 * identifier: REZICS mints Works as UUIDv7, so the greatest was created
 * last; a Work minted before that sorts by chance. Agents are credited as
 * authors natively; Open Library authors by a confirmed credit or a retained
 * adoption. An author with no such Work is absent.
 */
export async function newestAuthorWorks(session: WorkReadSession,
  authors: { agents: readonly string[]; keys: readonly string[] }): Promise<Map<string, string>> {
  const agents = [...new Set(authors.agents)], keys = [...new Set(authors.keys)];
  if (agents.length + keys.length > FOLLOWED_AUTHORS_COST.authors) {
    throw new WorkReadUnavailable('Followed author batch exceeds its bound');
  }
  const newest = new Map<string, string>();
  if (!agents.length && !keys.length) return newest;
  const reported = await Promise.all(keys.map(key => sourceReportedAuthorWorks(session, key)));
  const pairs = keys.flatMap((key, index) => reported[index]!.works.map(work => [work, key] as const));
  const branches = [
    ...keys.length ? [`{ ${creditedPublicWorks(keys, pairs)} BIND(?key AS ?author) }`] : [],
    ...agents.length ? [`{ VALUES ?agent { ${agents.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:agent ?agent ; rv:work ?id ;
        rv:creditRevision ?creditHead ; schema:roleName "author" . }
      GRAPH ${iri(GRAPHS.revisions)} { ?creditHead a rv:NativeAgentCreditRevision ; rv:component ?credit ;
        rv:agent ?agent ; rv:work ?id . FILTER NOT EXISTS { ?creditHead a rv:ErasedRevision } }
      ${publicWork('?id', '?main')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?id schema:isPartOf ?parentWork } }
      # A chapter placed in a book is the book's, as the profile's Works list reads it.
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ?legacyStructure a rv:Structure ; rv:structureProfile rv:BookComposition ;
          rv:selectedGeneration ?legacyGeneration .
        ?legacyPlacement a rv:OccurrencePlacement ; rv:generation ?legacyGeneration ;
          rv:occurrenceRole rv:ChapterRole ; schema:item ?id .
        FILTER NOT EXISTS { ?legacyPlacement rv:removedBy ?legacyRemoval } } }
      BIND(STR(?agent) AS ?author) }`] : [],
  ];
  const expected = agents.length + keys.length;
  const rows = await session.query(`SELECT ?author (MAX(STR(?id)) AS ?newest) WHERE {
    ${branches.join(' UNION ')} } GROUP BY ?author LIMIT ${expected + 1}`, expected + 1);
  for (const row of rows) {
    const author = row.author?.value, work = row.newest?.value;
    const target = author && keys.includes(author) ? externalAuthorFollow(author)
      : author && agents.includes(author) ? author : null;
    if (!target || !work || newest.has(target)) throw new WorkReadUnavailable('Newest author Works are ambiguous');
    newest.set(target, work);
  }
  return newest;
}
