import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { readEpochOrder } from '../discovery/lineage.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { RELEASE_QUERY_COST } from './release-contract.ts';
import { releaseGroupPattern, releaseWorkConditions, type ReleaseQuery } from './release-query.ts';

/** One bounded head-key window, then a public/release check of those candidates. Explanations read at most
 * nine distinct satisfying release IDs per Work, regardless of its release inventory size. */
export async function readReleaseWorks(session: WorkReadSession, query: ReleaseQuery) {
  if (query.scope.kind === 'realm') await readRealmBasis(session, query.scope.realm);
  else if (query.context !== 'global') await session.realm(query.context.realm);
  const binding = ['release-works-v1', query.context, query.scope, query.sort, query.groups,
    query.conditions, query.limit, session.displayLanguages];
  const cursor = decodeReadCursor(query.cursor, binding, session.position);
  let seek = '';
  if (cursor) {
    const [epoch, sequence] = cursor.order.split(':');
    if (!/^\d+$/.test(epoch ?? '') || !/^\d+$/.test(sequence ?? '') || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(cursor.after)) {
      throw new WorkReadInvalid('Release discovery cursor is invalid');
    }
    seek = `FILTER(?epochOrder > ${epoch} || (?epochOrder = ${epoch} &&
      (?sequence < ${sequence} || (?sequence = ${sequence} && STR(?work) > ${lit(cursor.after)}))))`;
  }
  const realm = query.scope.kind === 'realm' ? query.scope.realm : null;
  const scope = realm ? `GRAPH ${iri(GRAPHS.current)} { ?zoneSlot a rv:RealmPublicationSlot ;
    rv:realm ${iri(realm)} ; rv:work ?work ; rv:mainVersion ?main ; rv:selectionHead ?zoneSelection .
    ?zoneContribution rv:publicationHead ?zoneDecision }
    GRAPH ${iri(GRAPHS.revisions)} { ?zoneSelection a rv:PublicationSelection ; rv:component ?zoneSlot ;
      rv:context ${iri(realm)} ; rv:work ?work ; rv:mainVersion ?main ; rv:contribution ?zoneContribution ;
      rv:publicationDecision ?zoneDecision ; rv:selectedDraft ?zoneDraft .
      ?zoneDecision rv:disclosure rv:Public . FILTER NOT EXISTS { ?zoneDraft a rv:ErasedRevision } }` : '';
  const epochs = await readEpochOrder(session);
  const candidates = await session.query(`SELECT DISTINCT ?work ?head ?main ?epochOrder ?sequence WHERE {
    ${epochs}
    GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:head ?head ; rv:mainVersion ?main }
    GRAPH ${iri(GRAPHS.revisions)} { ?head rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence }
    ${seek}
  } ORDER BY ?epochOrder DESC(?sequence) STR(?work) LIMIT ${RELEASE_QUERY_COST.candidateRows + 1}`,
  RELEASE_QUERY_COST.candidateRows + 1);
  if (candidates.some(row => !row.work || !row.head || !row.main || !/^\d+$/.test(row.epochOrder?.value ?? '')
    || !/^\d+$/.test(row.sequence?.value ?? '')) || new Set(candidates.map(row => row.work!.value)).size !== candidates.length) {
    throw new WorkReadUnavailable('Release discovery Work identities are ambiguous');
  }
  const window = candidates.slice(0, RELEASE_QUERY_COST.candidateRows);
  // VALUES bounds every disclosure/coverage test. Never run these over the full Work population.
  const matched = window.length ? await session.query(`SELECT DISTINCT ?work WHERE {
    VALUES (?work ?main) { ${window.map(row => `(${iri(row.work!.value)} ${iri(row.main!.value)})`).join(' ')} }
    ${publicWork('?work', '?main')}
    ${scope}
    ${query.groups.map((group, index) => `FILTER EXISTS { ${releaseGroupPattern(group, `?release${index}`, String(index))} }`).join('\n')}
    ${releaseWorkConditions(query, '?publicContribution')}
  } LIMIT ${window.length + 1}`, window.length) : [];
  const idsMatched = new Set(matched.map(row => row.work?.value));
  if (matched.some(row => !row.work || !window.some(candidate => candidate.work!.value === row.work!.value))) {
    throw new WorkReadUnavailable('Release candidates changed');
  }
  const rows = window.filter(row => idsMatched.has(row.work!.value));
  const page = rows.slice(0, query.limit);
  const next = rows.length > query.limit ? page.at(-1)
    : candidates.length > window.length ? window.at(-1) : undefined;
  // A LIMIT in each subquery bounds explanation IDs per Work, not across the page.
  const explained = page.length ? await session.query(`SELECT ?work ?release WHERE {
    ${page.map((row, index) => `{ SELECT DISTINCT ?work ?release WHERE {
      VALUES ?work { ${iri(row.work!.value)} }
      ${query.groups.map((group, groupIndex) => `{ ${releaseGroupPattern(group, '?release', `ex${index}_${groupIndex}`)} }`).join(' UNION ')}
    } ORDER BY STR(?release) LIMIT ${RELEASE_QUERY_COST.explanationRows} }`).join(' UNION ')}
  }`, page.length * RELEASE_QUERY_COST.explanationRows) : [];
  const releases = new Map<string, string[]>();
  for (const row of explained) {
    if (!row.work || !row.release || !page.some(candidate => candidate.work!.value === row.work!.value)) {
      throw new WorkReadUnavailable('Release explanation is incomplete');
    }
    const list = releases.get(row.work.value) ?? [];
    if (list.includes(row.release.value)) throw new WorkReadUnavailable('Release explanation has duplicate identities');
    list.push(row.release.value);
    releases.set(row.work.value, list);
  }
  const ids = page.map(row => row.work!.value);
  const summaries = await session.summaries(ids);
  const items = page.map((row, index) => {
    const summary = summaries[index], matches = releases.get(row.work!.value);
    if (summary?.status !== 'available' || summary.disclosure !== 'public' || summary.type !== 'work' || !matches?.length) {
      throw new WorkReadUnavailable('Release discovery changed during hydration');
    }
    return { id: row.work!.value, revision: row.head!.value, mainVersion: row.main!.value,
      title: summary.name, cover: summary.avatar,
      matchedReleases: matches.sort().slice(0, RELEASE_QUERY_COST.matchedReleases),
      moreMatchedReleases: matches.length > RELEASE_QUERY_COST.matchedReleases };
  });
  // Policy/disclosure checks run again; workRead fences the graph position before returning.
  if ((await session.summaries(ids)).some(summary => summary.status !== 'available' || summary.disclosure !== 'public')) {
    throw new WorkReadUnavailable('Release discovery changed disclosure');
  }
  return { profile: 'release-works-v1' as const, resultGrain: 'work' as const,
    ...pageResult(session, items, next ? encodeReadCursor(binding, session.position,
      next.work!.value, `${next.epochOrder!.value}:${next.sequence!.value}`) : null) };
}

/** Enforce the operation's budget inside the shared read envelope, debiting its parent too.
 * Jena remote calls are separate transactions; workRead's before/after generation fence
 * rejects mixed snapshots: https://jena.apache.org/documentation/rdfconnection/#remote-transactions. */
export async function withReleaseQueryBudget<T>(read: () => Promise<T>): Promise<T> {
  const parent = fusekiReadBudget.getStore();
  let calls: number = RELEASE_QUERY_COST.graphCalls, bytes: number = RELEASE_QUERY_COST.graphBytes;
  const deadline = AbortSignal.timeout(RELEASE_QUERY_COST.deadlineMs);
  const budget = { signal: parent ? AbortSignal.any([parent.signal, deadline]) : deadline,
    get callsLeft() { return Math.min(calls, parent?.callsLeft ?? calls); },
    set callsLeft(value: number) { const used = this.callsLeft - value; calls -= used; if (parent) parent.callsLeft -= used; },
    get bytesLeft() { return Math.min(bytes, parent?.bytesLeft ?? bytes); },
    set bytesLeft(value: number) { const used = this.bytesLeft - value; bytes -= used; if (parent) parent.bytesLeft -= used; },
  };
  // Called inside the workRead operation: each retry gets a fresh attempt ledger.
  // The parent retains the whole-request deadline and aggregate call/byte bounds.
  return fusekiReadBudget.run(budget, read);
}
