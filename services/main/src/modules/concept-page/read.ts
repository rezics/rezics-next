import type { Static } from 'typebox';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import type { OwnedDiscoveryBasis } from '../discovery/contract.ts';
import { discoveryCards } from '../discovery/read.ts';
import { admitDiscoveryBasis } from '../discovery/source.ts';
import { DISCOVERY_CONDITION_COST, type DiscoveryCondition, type DiscoveryProjection } from '../discovery/store.ts';
import type { DiscoveryRow } from '../discovery/contract.ts';
import { checkedFilter, InvalidFilter } from '../facets/schema.ts';
import { type ResourceSummary, selectName } from '../media/summary.ts';
import { READ_BASIS_RETENTION_MS } from '../read-basis/retention.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadLimit, WorkReadMissing,
  WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { CONCEPT_FACET, CONCEPT_PAGE_COST, CONCEPT_WORKS_COST, type conceptPage, conceptFilter,
  type ConceptWorksQuery, type FilteredWorksQuery, conceptWorksFilter, type conceptWorksPage } from './contract.ts';

/**
 * A Concept a public page may show or filter by: active, unprotected and, when
 * a Realm owns it, owned by a public active Realm, as Concept search scopes it.
 * `tag` keeps the pattern's variables apart when it is used more than once.
 */
function visible(concept: string, tag: string) {
  return `${concept} a skos:Concept ; rv:conceptState rv:Active .
    FILTER NOT EXISTS { ${concept} rv:conceptState rv:Retired }
    FILTER NOT EXISTS { ${concept} rv:protectionHead ?${tag}Protection }
    FILTER NOT EXISTS { ${concept} rv:conceptRealm ?${tag}Realm .
      FILTER NOT EXISTS { ?${tag}Realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?${tag}Space .
        ?${tag}Space rv:realmCapability ?${tag}Realm ; rv:disclosure rv:Public .
        FILTER NOT EXISTS { ?${tag}Space rv:disclosure rv:Private } } }`;
}

interface ResolvedConcept { realm: string | null; interpretations: string[] }

/**
 * The visible Concepts among `concepts`, each with its Realm and the active
 * classification interpretations (Senses) that assert it. One graph query of
 * at most `concepts × (interpretations + 1)` rows; more interpretations than
 * that is a budget refusal, never a silently shortened Condition.
 */
export async function resolveConcepts(session: WorkReadSession, concepts: readonly string[]) {
  const limit = concepts.length * (CONCEPT_PAGE_COST.interpretations + 1);
  const rows = await session.query(`SELECT ?concept ?realm ?sense WHERE {
    VALUES ?concept { ${concepts.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} {
      ${visible('?concept', 'c')}
      OPTIONAL { ?concept rv:conceptRealm ?realm }
      OPTIONAL { ?expression rv:assertedConcept ?concept ; rv:expressionState rv:Active .
        ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:expression ?expression . }
    } } LIMIT ${limit + 1}`, limit);
  const resolved = new Map<string, ResolvedConcept>();
  for (const row of rows) {
    const concept = row.concept?.value;
    if (!concept || !concepts.includes(concept)) throw new WorkReadUnavailable('Concept read is ambiguous');
    const entry = resolved.get(concept) ?? { realm: row.realm?.value ?? null, interpretations: [] };
    if (entry.realm !== (row.realm?.value ?? null)) throw new WorkReadUnavailable('Concept Realm is ambiguous');
    const sense = row.sense?.value;
    if (sense && !entry.interpretations.includes(sense)) entry.interpretations.push(sense);
    if (entry.interpretations.length > CONCEPT_PAGE_COST.interpretations) {
      throw new WorkReadLimit('Concept has more interpretations than a page reads');
    }
    resolved.set(concept, entry);
  }
  for (const entry of resolved.values()) entry.interpretations.sort();
  return resolved;
}

type Name = Static<typeof conceptPage>['name'];
const nameOf = (summary: ResourceSummary | undefined): Name | null =>
  summary?.status === 'available' && summary.type === 'concept'
    ? { value: summary.name.value, language: summary.name.language, direction: summary.name.direction,
      basis: summary.name.basis } : null;

/** `GET /v1/concepts/{id}`: what a Concept is, where it sits and what following it follows. */
export async function readConcept(session: WorkReadSession, id: string): Promise<Static<typeof conceptPage>> {
  const cost = CONCEPT_PAGE_COST;
  const concept = (await resolveConcepts(session, [id])).get(id);
  if (!concept) throw new WorkReadMissing('Concept is unavailable');
  const related = (relation: 'broader' | 'narrower', limit: number) => `{ SELECT DISTINCT ?other
    ("${relation}" AS ?relation) WHERE { GRAPH ${iri(GRAPHS.current)} {
      { ${iri(id)} skos:${relation} ?other } UNION { ?other skos:${relation === 'broader' ? 'narrower' : 'broader'} ${iri(id)} }
      FILTER(?other != ${iri(id)})
      ${visible('?other', relation)}
    } } ORDER BY STR(?other) LIMIT ${limit + 1} }`;
  const rows = await session.query(`SELECT ?relation ?other ?definition WHERE {
    { SELECT ?definition WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(id)} skos:definition ?definition } }
      LIMIT ${cost.definitions + 1} }
    UNION ${related('broader', cost.broader)}
    UNION ${related('narrower', cost.narrower)}
  }`, cost.definitions + cost.broader + cost.narrower + 3);
  const definitions = new Map<string, string>();
  for (const row of rows) {
    const language = (row.definition as { 'xml:lang'?: string } | undefined)?.['xml:lang']?.toLowerCase();
    if (row.definition && language) definitions.set(language, row.definition.value);
  }
  if (definitions.size > cost.definitions) throw new WorkReadLimit('Concept has more definitions than a page reads');
  const others = (relation: string) => rows.flatMap(row => row.relation?.value === relation && row.other
    ? [row.other.value] : []);
  const broader = others('broader'), narrower = others('narrower');
  const listed = [...broader.slice(0, cost.broader), ...narrower.slice(0, cost.narrower)];
  const summaries = new Map((await session.summaries([id, ...listed])).map(summary => [summary.reference, summary]));
  const name = nameOf(summaries.get(id));
  if (!name) throw new WorkReadMissing('Concept is unavailable');
  const links = (ids: string[], limit: number) => ids.slice(0, limit).flatMap(other => {
    const named = nameOf(summaries.get(other));
    return named ? [{ id: other, name: named }] : [];
  });
  return { profile: 'concept-v1', id, name,
    description: selectName(definitions, session.options.language?.toLowerCase() ?? null),
    realm: concept.realm, facet: CONCEPT_FACET, interpretations: concept.interpretations,
    broader: links(broader, cost.broader), narrower: links(narrower, cost.narrower),
    moreNarrower: narrower.length > cost.narrower, filter: conceptFilter(id), sourcePosition: session.position };
}

/**
 * `GET /v1/concepts/{id}/works`: public Works newest first whose accepted
 * values meet the Concept's Condition bar, from the scope's discovery
 * projection. Included values match all or any; excluded ones never. With
 * `all`, the included value with the fewest Works drives the seek and the
 * rest are checked per Work. A stale projection withholds its matches, as a
 * Discover genre shelf does.
 */
export async function readConceptWorks(session: WorkReadSession, projection: DiscoveryProjection, concept: string,
  query: ConceptWorksQuery): Promise<Static<typeof conceptWorksPage>> {
  const include = query.include ?? [], exclude = query.exclude ?? [], match = query.match ?? 'all';
  if ([concept, ...include].some(value => exclude.includes(value)) || include.includes(concept)) {
    throw new WorkReadInvalid('A value is both included and excluded, or repeats the page’s Concept');
  }
  const filter = conceptWorksFilter(concept, include, exclude, match);
  try { checkedFilter(filter); } catch (error) {
    if (error instanceof InvalidFilter) throw new WorkReadInvalid(error.message);
    throw error;
  }
  const basis: OwnedDiscoveryBasis = { scope: query.scope ?? 'global', realm: query.realm ?? null, context: null,
    owner: null };
  await admitDiscoveryBasis(session, basis);
  const all = [concept, ...include, ...exclude];
  const resolved = await resolveConcepts(session, all);
  if (all.some(value => !resolved.has(value))) throw new WorkReadMissing('Concept is unavailable');
  const summaries = new Map((await session.summaries(all)).map(summary => [summary.reference, summary]));
  const values = all.map(value => {
    const name = nameOf(summaries.get(value));
    if (!name) throw new WorkReadMissing('Concept is unavailable');
    return { id: value, name, operator: exclude.includes(value) ? 'exclude' as const : 'include' as const };
  });

  const binding = ['concept-works-v1', basis, concept, match, [...include].sort(), [...exclude].sort(),
    query.type ?? '', session.options.language?.toLowerCase() ?? null];
  const cursor = decodeReadCursor(query.cursor, binding, session.position, true);
  let after: { generation: string; key: string; seen: number } | undefined;
  if (cursor) {
    try {
      after = JSON.parse(cursor.order) as typeof after;
      if (!after || !/^[0-9a-f-]{36}$/.test(after.generation) || !/^\d+$/.test(after.key)
        || !Number.isSafeInteger(after.seen) || after.seen < 0) throw new Error('cursor');
    } catch { throw new WorkReadInvalid('Concept Works cursor is invalid'); }
  }
  const active = await projection.active(basis, session.position, after?.generation);
  const interpretations = (value: string) => resolved.get(value)!.interpretations;
  const included = [concept, ...include].map(interpretations);
  const excluded = exclude.flatMap(interpretations);
  let condition: DiscoveryCondition | null;
  if (match === 'any') {
    const drive = included.flat();
    condition = drive.length ? { drive, groups: [], excluded } : null;
  } else if (included.some(group => !group.length)) {
    // A value no Work was ever classified under: nothing can carry every value.
    condition = null;
  } else {
    if (included.flat().length > CONCEPT_WORKS_COST.countedTerms) {
      throw new WorkReadLimit('Included values have more interpretations than a page counts');
    }
    const counts = new Map((await projection.selectedTerms(active, included.flat()))
      .map(row => [row.term, Number(row.work_count)]));
    const size = (group: string[]) => group.reduce((sum, term) => sum + (counts.get(term) ?? 0), 0);
    const rarest = included.reduce((best, group) => size(group) < size(best) ? group : best);
    condition = size(rarest) ? { drive: rarest, groups: included.filter(group => group !== rarest), excluded } : null;
  }
  const limit = query.limit ?? CONCEPT_WORKS_COST.pageSize;
  const page = condition ? await projection.conditionPage(active, query.type ?? '', condition, limit,
    after && cursor ? { key: after.key, work: cursor.after } : undefined) : { rows: [], next: null };
  const items = await discoveryCards(session, page.rows, query.type ?? null, new Set(condition?.drive ?? []));
  const final = await projection.active(basis, session.position, active.generation_id);
  const stale = active.stale || final.stale;
  const visibleItems = stale ? [] : items;
  const seen = (after?.seen ?? 0) + visibleItems.length;
  if (!Number.isSafeInteger(seen)) throw new WorkReadLimit('Concept Works count exceeds its integer domain');
  const next = page.next ? encodeReadCursor(binding, session.position, page.next.work,
    JSON.stringify({ generation: active.generation_id, key: page.next.key, seen }),
    cursor?.expiresAt ?? Date.now() + READ_BASIS_RETENTION_MS) : null;
  return { profile: 'concept-works-v1', concept, scope: { kind: basis.scope, realm: basis.realm }, match, filter,
    values, generation: active.generation_id, stale,
    projectionPosition: { dataEpoch: active.source_epoch, sequence: active.source_sequence },
    ...pageResult(session, visibleItems, next),
    matches: { value: seen, kind: next || stale ? 'lower-bound' : 'exact' } };
}

/** Whether a Work's Senses meet included groups and carry none of the excluded Senses. */
export function conceptMembership(terms: ReadonlySet<string>, included: readonly (readonly string[])[],
  excluded: readonly string[], match: 'all' | 'any'): boolean {
  const present = (group: readonly string[]) => group.some(term => terms.has(term));
  const includes = included.length === 0 || (match === 'all' ? included.every(present) : included.some(present));
  return includes && excluded.every(term => !terms.has(term));
}

/**
 * Discover's Condition on the Query: include, exclude-only, top-rated and Mine.
 * Mine keeps the reader's rating order and checks Concepts on the public index.
 */
export async function readFilteredWorks(session: WorkReadSession, projection: DiscoveryProjection,
  query: FilteredWorksQuery): Promise<Static<typeof conceptWorksPage>> {
  const include = query.include ?? [], exclude = query.exclude ?? [], match = query.match ?? 'all';
  const sort = query.sort ?? 'recent';
  const mine = query.scope === 'mine';
  if (sort === 'top-rated' && !query.context) throw new WorkReadInvalid('Top-rated requires a standing rating Context');
  if (mine && !query.context) throw new WorkReadInvalid('Mine requires a standing rating Context');
  if ((!include.length && !exclude.length) || include.some(value => exclude.includes(value))
    || new Set([...include, ...exclude]).size !== include.length + exclude.length) {
    throw new WorkReadInvalid('Concept filter needs distinct values');
  }
  const primary = include[0] ?? exclude[0]!;
  const filter = { all: [
    ...(include.length ? [match === 'all' ? { facet: CONCEPT_FACET, all: include }
      : { facet: CONCEPT_FACET, any: include }] : []),
    ...(exclude.length ? [{ facet: CONCEPT_FACET, none: exclude }] : []),
  ] };
  try { checkedFilter(filter); } catch (error) {
    if (error instanceof InvalidFilter) throw new WorkReadInvalid(error.message);
    throw error;
  }
  const listBasis: OwnedDiscoveryBasis = mine
    ? { scope: 'mine', realm: null, context: query.context!, owner: null }
    : { scope: query.scope === 'realm' ? 'realm' : 'global', realm: query.realm ?? null,
      context: sort === 'top-rated' ? query.context! : null, owner: null };
  await admitDiscoveryBasis(session, listBasis);
  if (mine) {
    listBasis.owner = session.principal ? await session.deps.access.activePrincipalId(session.principal) : null;
    if (!listBasis.owner) throw new AccountAssertionDenied('Mine requires an active principal');
  }
  const resolved = await resolveConcepts(session, [...include, ...exclude]);
  if ([...include, ...exclude].some(value => !resolved.has(value))) throw new WorkReadMissing('Concept is unavailable');
  const summaries = new Map((await session.summaries([...include, ...exclude]))
    .map(summary => [summary.reference, summary]));
  const values = [...include, ...exclude].map(value => {
    const name = nameOf(summaries.get(value));
    if (!name) throw new WorkReadMissing('Concept is unavailable');
    return { id: value, name, operator: exclude.includes(value) ? 'exclude' as const : 'include' as const };
  });
  const interpretations = (value: string) => resolved.get(value)!.interpretations;
  const includedGroups = include.map(interpretations);
  const excludedSenses = exclude.flatMap(interpretations);
  const binding = ['concept-filter-v1', listBasis, sort, match, [...include].sort(), [...exclude].sort(),
    query.type ?? '', session.options.language?.toLowerCase() ?? null];
  const cursor = decodeReadCursor(query.cursor, binding, session.position, true);
  let after: { generation: string; key: string; seen: number } | undefined;
  if (cursor) {
    try {
      after = JSON.parse(cursor.order) as typeof after;
      if (!after || !/^[0-9a-f-]{36}$/.test(after.generation) || !/^-?\d+(\.\d+)?$/.test(after.key)
        || !Number.isSafeInteger(after.seen) || after.seen < 0) throw new Error('cursor');
    } catch { throw new WorkReadInvalid('Concept Works cursor is invalid'); }
  }
  const active = await projection.active(listBasis, session.position, after?.generation);
  const order = sort === 'top-rated' ? 'top-rated' as const : 'recent' as const;
  const limit = query.limit ?? CONCEPT_WORKS_COST.pageSize;
  const seek = after && cursor ? { key: after.key, work: cursor.after } : undefined;
  let rows: DiscoveryRow[] = [];
  let nextSeek: { key: string; work: string } | null = null;
  let cardTerms: ReadonlySet<string> | null = null;
  if (mine) {
    const classBasis: OwnedDiscoveryBasis = { scope: 'global', realm: null, context: null, owner: null };
    await admitDiscoveryBasis(session, classBasis);
    const classified = await projection.active(classBasis, session.position);
    const wanted = [...new Set([...includedGroups.flat(), ...excludedSenses])];
    let scanned = 0;
    let cursorKey = seek;
    const cap = DISCOVERY_CONDITION_COST.window;
    while (rows.length <= limit && scanned < cap) {
      const ask = Math.min(CONCEPT_WORKS_COST.pageSize, cap - scanned);
      const batch = await projection.page(active, order, query.type ?? '', '', ask, cursorKey);
      const slice = batch.slice(0, ask);
      if (!slice.length) break;
      scanned += slice.length;
      const membership = wanted.length ? await projection.termMembership(classified, slice.map(row => row.work), wanted) : [];
      const byWork = new Map<string, Set<string>>();
      for (const item of membership) {
        const set = byWork.get(item.work) ?? new Set<string>();
        set.add(item.term);
        byWork.set(item.work, set);
      }
      for (const row of slice) {
        if (conceptMembership(byWork.get(row.work) ?? new Set(), includedGroups, excludedSenses, match)) rows.push(row);
      }
      cursorKey = { key: slice.at(-1)!.order_key, work: slice.at(-1)!.work };
      if (batch.length <= ask) break;
      if (rows.length > limit) break;
    }
    nextSeek = rows.length > limit ? { key: rows[limit - 1]!.order_key, work: rows[limit - 1]!.work } : null;
    // Continue after the last examined Work when the window filled before the page did.
    if (!nextSeek && scanned >= cap && rows.length <= limit) {
      nextSeek = cursorKey ?? null;
    }
    rows = rows.slice(0, limit);
  } else if (!include.length) {
    const page = await projection.conditionPage(active, query.type ?? '',
      { drive: [''], groups: [], excluded: excludedSenses }, limit, seek, order);
    rows = page.rows;
    nextSeek = page.next;
  } else if (match === 'any') {
    const drive = includedGroups.flat();
    cardTerms = new Set(drive);
    const page = drive.length ? await projection.conditionPage(active, query.type ?? '',
      { drive, groups: [], excluded: excludedSenses }, limit, seek, order) : { rows: [], next: null };
    rows = page.rows;
    nextSeek = page.next;
  } else if (includedGroups.some(group => !group.length)) {
    rows = [];
  } else {
    if (includedGroups.flat().length > CONCEPT_WORKS_COST.countedTerms) {
      throw new WorkReadLimit('Included values have more interpretations than a page counts');
    }
    const counts = new Map((await projection.selectedTerms(active, includedGroups.flat()))
      .map(row => [row.term, Number(row.work_count)]));
    const size = (group: string[]) => group.reduce((sum, term) => sum + (counts.get(term) ?? 0), 0);
    const rarest = includedGroups.reduce((best, group) => size(group) < size(best) ? group : best);
    cardTerms = new Set(rarest);
    const page = size(rarest) ? await projection.conditionPage(active, query.type ?? '',
      { drive: rarest, groups: includedGroups.filter(group => group !== rarest), excluded: excludedSenses },
      limit, seek, order) : { rows: [], next: null };
    rows = page.rows;
    nextSeek = page.next;
  }
  const items = await discoveryCards(session, rows, query.type ?? null, cardTerms);
  const final = await projection.active(listBasis, session.position, active.generation_id);
  const stale = active.stale || final.stale;
  const visibleItems = stale ? [] : items;
  const seen = (after?.seen ?? 0) + visibleItems.length;
  if (!Number.isSafeInteger(seen)) throw new WorkReadLimit('Concept Works count exceeds its integer domain');
  const next = nextSeek ? encodeReadCursor(binding, session.position, nextSeek.work,
    JSON.stringify({ generation: active.generation_id, key: nextSeek.key, seen }),
    cursor?.expiresAt ?? Date.now() + READ_BASIS_RETENTION_MS) : null;
  return { profile: 'concept-works-v1', concept: primary, scope: { kind: listBasis.scope, realm: listBasis.realm },
    match, filter, values, generation: active.generation_id, stale,
    projectionPosition: { dataEpoch: active.source_epoch, sequence: active.source_sequence },
    ...pageResult(session, visibleItems, next),
    matches: { value: seen, kind: next || stale ? 'lower-bound' : 'exact' } };
}
