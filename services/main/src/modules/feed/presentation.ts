import { namedDiscoveryCredits } from '../discovery/credits.ts';
import { DISCOVERY_COST, type DiscoveryCredit, type ProjectedCredit } from '../discovery/contract.ts';
import { readAuthorNames, sourceReportedCredits } from '../source/author-name-read.ts';
import { GRAPHS, iri, MAX_WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import { workSemanticTypes } from '../work/work-kinds.ts';
import { metadataComponent, METADATA_PROFILE } from '../work/metadata-schema.ts';
import { parsedMetadataState, selectedMetadata } from '../work/metadata-read.ts';
import { type ReadRow, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { externalAuthorFollow, FOLLOWS_COST } from '../follows/contract.ts';
import { FEED_COST, type FeedKind } from './contract.ts';
import type { FeedSource } from './source.ts';

/** Every author credit of the Works, Agents first, then Open Library authors by position; 64 per Work at most. */
const authorCreditsQuery = (ids: readonly string[]) => `SELECT ?work ?id ?revision ?key ?ordinal ?agent WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:AuthorCredit ; rv:work ?work ;
        rv:creditRevision ?revision ; schema:roleName "author" ; rv:externalProvider "open-library" ;
        rv:externalNamespace "author" ; rv:externalKey ?key ; schema:position ?ordinal ; rv:editControl rv:HumanConfirmed . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:AuthorCreditRevision ; rv:component ?id ;
        rv:work ?work ; rv:externalKey ?key ; schema:position ?ordinal .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
    UNION
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:NativeAgentCredit ; rv:work ?work ;
        rv:creditRevision ?revision ; rv:agent ?agent ; schema:roleName "author" . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeAgentCreditRevision ; rv:component ?id ;
        rv:work ?work ; rv:agent ?agent ; schema:roleName "author" .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
  } ORDER BY ?work ?ordinal STR(?id) LIMIT ${ids.length * 64 + 1}`;

/** Card kinds that are an author's news: their Work published or added, and a new chapter or update of it. */
export const AUTHOR_NEWS_KINDS: readonly FeedKind[] = ['work', 'added', 'contribution'];

/** A credit as the author a reader follows: the Agent, or the keyed Open Library author. */
export interface CreditedAuthor { agent: string | null; key: string | null }

/** Card kinds that are a Realm's own act, whoever carried it out: a pick or a decision. */
const REALM_ACT_KINDS: readonly FeedKind[] = ['adoption', 'decision'];

/**
 * What a follow can match on a card, the first match being its reason: for
 * an author's news the authors the card credits, in credit order, then the
 * poster, then its Realm, Zone and Work. A followed person outranks a
 * followed Realm, so the card can lead with them; a Realm's own act answers
 * to the Realm before whoever acted for it. At most `FOLLOWS_COST.matchIdentities`.
 */
export function followIdentities(source: Pick<FeedSource, 'kind' | 'realm' | 'zone' | 'work' | 'actor'>,
  authors: readonly CreditedAuthor[] = []): string[] {
  const credited = AUTHOR_NEWS_KINDS.includes(source.kind)
    ? authors.slice(0, DISCOVERY_COST.primaryCredits).map(author => author.agent
      ?? (author.key ? externalAuthorFollow(author.key) : null)) : [];
  const act = REALM_ACT_KINDS.includes(source.kind);
  const ids = [...new Set([...credited, act ? null : source.actor, source.realm, source.zone, source.work,
    act ? source.actor : null].filter((id): id is string => !!id))];
  if (ids.length > FOLLOWS_COST.matchIdentities) throw new WorkReadUnavailable('Feed follow match exceeds its bound');
  return ids;
}

/**
 * The authors each Work's card credits (the first three, in credit order),
 * without the names a card draws: one credit query and one Source batch for
 * at most twenty Works. The feed head matches follows with it.
 */
export async function feedWorkAuthors(session: WorkReadSession, works: readonly string[]) {
  const ids = [...new Set(works)];
  if (ids.length > FOLLOWS_COST.matchCards) throw new WorkReadUnavailable('Feed author batch exceeds its bound');
  const authors = new Map<string, CreditedAuthor[]>();
  if (!ids.length) return authors;
  const rows = await session.query(authorCreditsQuery(ids), ids.length * 64 + 1);
  if (rows.length > ids.length * 64 || rows.some(row => !row.work || !ids.includes(row.work.value) || !row.id
    || !row.agent === !row.key)) throw new WorkReadUnavailable('Feed credits are ambiguous');
  const confirmed = new Map(ids.map(work => [work, [] as (CreditedAuthor & { id: string; ordinal: number | null })[]]));
  for (const row of rows) {
    const list = confirmed.get(row.work!.value)!;
    if (list.length < DISCOVERY_COST.primaryCredits) list.push({ id: row.id!.value, agent: row.agent?.value ?? null,
      key: row.key?.value ?? null, ordinal: row.agent ? null : Number(row.ordinal?.value) });
  }
  const reported = await sourceReportedCredits(session, ids);
  for (const work of ids) {
    const own = confirmed.get(work)!;
    const keys = new Set(own.flatMap(credit => credit.key ? [credit.key] : []));
    authors.set(work, [...own, ...(reported.get(work) ?? []).filter(credit => !keys.has(credit.key))]
      .sort((a, b) => (a.ordinal ?? -1) - (b.ordinal ?? -1) || a.id.localeCompare(b.id))
      .slice(0, DISCOVERY_COST.primaryCredits).map(credit => ({ agent: credit.agent, key: credit.key })));
  }
  return authors;
}

export interface FeedWorkPresentation { authors: DiscoveryCredit[]; excerpt: string | null; language: string | null;
  /** The Work's semantic types, so a card draws the cover every other page draws. */
  types: string[] }

/** One metadata batch, one type batch, one credit batch, one name batch and one
 * preview batch for the admitted Works. The final fence checks pointers, types
 * and credit identity without hydrating metadata states or preview bodies a
 * second time. */
export async function feedWorkPresentations(session: WorkReadSession, works: readonly string[]) {
  const ids = [...new Set(works)];
  if (ids.length > FEED_COST.candidates) throw new WorkReadUnavailable('Feed Work presentation budget exceeded');
  const items = new Map<string, FeedWorkPresentation>();
  if (!ids.length) return { items, fence: async () => {} };
  const values = ids.map(iri).join(' ');
  const pointersQuery = `SELECT ?work ?head ?main ?selection WHERE {
    VALUES ?work { ${values} }
    GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork .
      OPTIONAL { ?work rv:descriptiveMetadataHead ?head }
      OPTIONAL { ?work rv:mainVersion ?main . ?main rv:selectionHead ?selection } }
  } LIMIT ${ids.length + 1}`;
  const components = ids.map(work => [work, metadataComponent(work,
    { kind: 'header', originalTitle: null, localized: [] })] as const);
  const pointers = await session.query(`SELECT ?work ?head ?main ?selection ?state WHERE {
    VALUES (?work ?component) { ${components.map(([work, component]) => `(${iri(work)} ${iri(component)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork .
      OPTIONAL { ?work rv:descriptiveMetadataHead ?head }
      OPTIONAL { ?work rv:mainVersion ?main . ?main rv:selectionHead ?selection } }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work rv:descriptiveMetadataHead ?head .
        ?component a rv:WorkMetadataComponent ; rv:metadataKind "header" ;
          rv:work ?work ; rv:metadataHead ?head }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:WorkMetadataRevision ; rv:component ?component ;
        rv:modelRevision ${iri(METADATA_PROFILE)} ; rv:shapeRevision ${iri(METADATA_PROFILE)} ;
        rv:metadataState ?state } }
  } LIMIT ${ids.length + 1}`, ids.length + 1);
  const pointerSignature = (rows: typeof pointers) => {
    if (rows.length !== ids.length || new Set(rows.map(row => row.work?.value)).size !== ids.length
      || rows.some(row => !row.work || !ids.includes(row.work.value) || row.selection && !row.main)) {
      throw new WorkReadUnavailable('Feed Work pointers are ambiguous');
    }
    return rows.map(row => [row.work!.value, row.head?.value ?? null,
      row.main?.value ?? null, row.selection?.value ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };
  const originalPointers = pointerSignature(pointers);
  const states = new Map(pointers.filter(row => row.state).map(row => [row.work?.value, row.state!.value]));
  if (states.size !== pointers.filter(row => row.state).length
    || pointers.some(row => !!row.head !== states.has(row.work!.value))) {
    throw new WorkReadUnavailable('Feed metadata heads are incomplete');
  }

  const typesQuery = `SELECT ?work ?type WHERE { VALUES ?work { ${values} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type . VALUES ?type { ${workSemanticTypes.map(type => `<${type}>`).join(' ')} } }
  } ORDER BY ?work ?type LIMIT ${ids.length * MAX_WORK_SEMANTIC_TYPES + 1}`;
  const typeSignature = (rows: readonly ReadRow[]) => {
    if (rows.length > ids.length * MAX_WORK_SEMANTIC_TYPES
      || rows.some(row => !row.work || !ids.includes(row.work.value) || !row.type)) {
      throw new WorkReadUnavailable('Feed Work types are ambiguous');
    }
    return rows.map(row => [row.work!.value, row.type!.value]);
  };
  const originalTypes = typeSignature(await session.query(typesQuery, ids.length * MAX_WORK_SEMANTIC_TYPES + 1));
  const types = new Map<string, string[]>(ids.map(work => [work, []]));
  for (const [work, type] of originalTypes) types.get(work!)!.push(type!);

  const creditQuery = authorCreditsQuery(ids);
  const creditRows = await session.query(creditQuery, ids.length * 64 + 1);
  const creditSignature = (rows: typeof creditRows) => {
    if (rows.length > ids.length * 64 || rows.some(row => !row.work || !ids.includes(row.work.value)
      || !row.id || !row.revision || (!row.agent && (!row.key || !/^\d+$/.test(row.ordinal?.value ?? '')
        || !Number.isSafeInteger(Number(row.ordinal?.value)))) || (row.agent && (row.key || row.ordinal)))
      || new Set(rows.map(row => row.id!.value)).size !== rows.length) {
      throw new WorkReadUnavailable('Feed credits are ambiguous');
    }
    return rows.map(row => [row.work!.value, row.id!.value, row.revision!.value, row.key?.value ?? null,
      row.ordinal?.value ?? null, row.agent?.value ?? null]);
  };
  const originalCredits = creditSignature(creditRows);
  const credits = new Map<string, ProjectedCredit[]>(ids.map(work => [work, []]));
  for (const row of creditRows) {
    const selected = credits.get(row.work!.value)!;
    if (selected.length >= DISCOVERY_COST.primaryCredits) continue;
    selected.push(row.agent ? { id: row.id!.value, role: 'author', participantKind: 'agent',
      provider: null, key: null, ordinal: null, agent: row.agent.value, displayName: null, handle: null }
      : { id: row.id!.value, role: 'author', participantKind: 'external-reference',
        provider: 'open-library', key: row.key!.value, ordinal: Number(row.ordinal!.value),
        agent: null, displayName: null, handle: null });
  }
  const names = await namedDiscoveryCredits(session, [...credits.values()].flat(), ids.length);
  const reported = await sourceReportedCredits(session, ids);
  const sourceNames = await readAuthorNames(session, [...credits.values()].flat().flatMap(credit =>
    credit.key !== null ? [credit.key] : []));
  const excerpts = new Map<string, { excerpt: string | null; language: string | null }>();
  for (const work of ids) {
    const raw = states.get(work);
    const state = raw ? parsedMetadataState(raw) : { kind: 'header' as const, originalTitle: null, localized: [] };
    if (state.kind !== 'header') throw new WorkReadUnavailable('Feed metadata head has the wrong kind');
    const selected = selectedMetadata(state, session.options.language);
    const value = selected.tagline ?? selected.description;
    excerpts.set(work, { excerpt: value?.value.slice(0, 400) ?? null, language: value?.language ?? null });
  }
  const missing = ids.filter(work => !excerpts.get(work)?.excerpt);
  if (missing.length) {
    const bodies = await session.query(`SELECT ?work ?language (SUBSTR(STR(?body), 1, 400) AS ?preview) WHERE {
      VALUES ?work { ${missing.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?main . ?main rv:selectionHead ?selection . }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ; rv:mainVersion ?main ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft ; rv:language ?language .
        ?decision rv:disclosure rv:Public ; rv:selectedDraft ?draft .
        FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
      # Joined from the bound selection: on its own this pattern names every contribution.
      GRAPH ${iri(GRAPHS.current)} { ?contribution rv:publicationHead ?decision . }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:selection ?selection ; rv:revision ?draft ; rv:searchBody ?body }
    } ORDER BY ?work ?language LIMIT ${missing.length * 64 + 1}`, missing.length * 64 + 1);
    const grouped = new Map<string, typeof bodies>();
    for (const row of bodies) {
      if (!row.work || !missing.includes(row.work.value) || !row.language || !row.preview) {
        throw new WorkReadUnavailable('Feed Main preview is ambiguous');
      }
      const group = grouped.get(row.work.value) ?? [];
      group.push(row); grouped.set(row.work.value, group);
      if (group.length > 64) throw new WorkReadUnavailable('Feed Main preview exceeds language bound');
    }
    if (bodies.length > missing.length * 64) throw new WorkReadUnavailable('Feed Main preview exceeds language bound');
    for (const [work, group] of grouped) {
      const preferred = group.find(row => row.language!.value.toLowerCase() === session.options.language?.toLowerCase())
        ?? group.find(row => row.language!.value === 'en') ?? group[0]!;
      excerpts.set(work, { excerpt: preferred.preview!.value, language: preferred.language!.value });
    }
  }
  for (const work of ids) {
    const confirmed = credits.get(work) ?? [];
    const confirmedKeys = new Set(confirmed.flatMap(credit => credit.key !== null ? [credit.key] : []));
    const merged = [...confirmed, ...(reported.get(work) ?? []).filter(credit =>
      !confirmedKeys.has(credit.key))]
      .sort((a, b) => (a.ordinal ?? -1) - (b.ordinal ?? -1) || a.id.localeCompare(b.id))
      .slice(0, DISCOVERY_COST.primaryCredits);
    const authors = merged.flatMap(credit => {
      if (!credit.agent) return [{ ...credit, ...sourceNames.get(credit.key!) } as DiscoveryCredit];
      const name = names.get(credit.agent);
      return name ? [{ ...credit, ...name } as DiscoveryCredit] : [];
    });
    items.set(work, { authors, ...excerpts.get(work)!, types: types.get(work)! });
  }
  return { items, fence: async () => {
    if (JSON.stringify(pointerSignature(await session.query(pointersQuery, ids.length + 1)))
      !== JSON.stringify(originalPointers)
      || JSON.stringify(creditSignature(await session.query(creditQuery, ids.length * 64 + 1)))
      !== JSON.stringify(originalCredits)
      || JSON.stringify(typeSignature(await session.query(typesQuery, ids.length * MAX_WORK_SEMANTIC_TYPES + 1)))
      !== JSON.stringify(originalTypes)) throw new WorkReadMoved('Feed Work presentation changed');
    const currentNames = await namedDiscoveryCredits(session, [...credits.values()].flat(), ids.length);
    if (JSON.stringify([...currentNames]) !== JSON.stringify([...names])) throw new WorkReadMoved('Feed Work author changed');
  } };
}
