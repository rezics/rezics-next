import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadLimit,
  WorkReadMissing, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { canonicalChapterWorks } from '../structure/chapter-work.ts';
import { readShelfPage, type ShelfOptions } from './shelf-page.ts';
import type { ReaderLibraryStatusStore, ReadingStatus } from './status.ts';

const id = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const READER_LIBRARY_COST = { batchWorks: 24, graphCalls: 64, graphRows: 481,
  sqlReads: 16, responseBytes: 256 * 1024 } as const;

export async function readReaderStates(session: WorkReadSession, agent: string, works: string[],
  status: ReaderLibraryStatusStore, realm?: string) {
  if (!session.principal || works.length > READER_LIBRARY_COST.batchWorks
    || new Set(works).size !== works.length || works.some(work => !id.test(work))) {
    throw new WorkReadInvalid('Invalid reader state batch');
  }
  const parents = await canonicalChapterWorks(session, works);
  works = works.map(work => parents.get(work) ?? work);
  if (new Set(works).size !== works.length) throw new WorkReadInvalid('Duplicate parent Work in reader state batch');
  const before = await session.deps.profiles?.agentFence(agent);
  if (!before) throw new WorkReadMissing('Reader Agent is unavailable');
  const statusFence = await status.fence(agent);
  const summaries = await session.summaries(works);
  if (summaries.some(summary => summary.status !== 'available' || summary.type !== 'work')) {
    throw new WorkReadMissing('Work is unavailable');
  }
  const states = await status.batch(agent, works);
  const shelves = new Map<string, { id: string; name: string; disclosure: 'public' | 'private' }[]>();
  const structures = new Map<string, string>();
  let currentMains: { work: string; main: string }[] = [];
  if (works.length) {
    const mainRows = await session.query(`SELECT ?work ?main WHERE {
      VALUES ?work { ${works.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:mainVersion ?main . }
    } LIMIT 25`, 25);
    if (mainRows.length !== works.length || new Set(mainRows.map(row => row.work!.value)).size !== works.length) {
      throw new WorkReadUnavailable('Work main versions are ambiguous');
    }
    currentMains = mainRows.map(row => ({ work: row.work!.value, main: row.main!.value }));
    const compositionRows = await session.query(`SELECT ?work ?structure WHERE {
      VALUES ?work { ${works.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        ?work rv:mainVersion ?main .
        ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile rv:BookComposition ;
          rv:selectedGeneration ?generation .
        ?generation rv:generationState rv:Active .
      }
    } LIMIT 25`, 25);
    for (const row of compositionRows) {
      if (structures.has(row.work!.value)) throw new WorkReadUnavailable('Work composition is ambiguous');
      structures.set(row.work!.value, row.structure!.value);
    }
    const rows = await session.query(`SELECT DISTINCT ?work ?collection ?name ?disclosure WHERE {
      VALUES ?work { ${works.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        ?collection a rv:Collection ; rv:curator ${iri(agent)} ; rv:collectionState rv:Active ;
          rv:disclosure ?disclosure ; schema:name ?name ; rv:structure ?structure .
        ?structure rv:selectedGeneration ?generation .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
          rv:occurrenceRole rv:MemberRole ; schema:item ?work .
        FILTER NOT EXISTS { ?collection rv:protectionHead ?protection }
      }
      FILTER(?disclosure IN (rv:Public, rv:Private))
    } ORDER BY STR(?work) STR(?collection) LIMIT ${READER_LIBRARY_COST.graphRows}`,
    READER_LIBRARY_COST.graphRows);
    if (rows.length === READER_LIBRARY_COST.graphRows) throw new WorkReadLimit('Too many custom shelves');
    for (const row of rows) {
      const work = row.work?.value;
      const collection = row.collection?.value;
      const name = row.name?.value;
      const disclosure = row.disclosure?.value;
      if (!work || !collection || !name || !id.test(collection)
        || ![`${RV}Public`, `${RV}Private`].includes(disclosure ?? '')) {
        throw new WorkReadUnavailable('Custom shelf is ambiguous');
      }
      const list = shelves.get(work) ?? [];
      if (list.some(item => item.id === collection)) throw new WorkReadUnavailable('Custom shelf is ambiguous');
      list.push({ id: collection, name,
        disclosure: disclosure === `${RV}Public` ? 'public' : 'private' });
      shelves.set(work, list);
    }
  }
  const progress = await status.progress(session.principal, [...structures.values()]);
  if (!session.deps.libraryRatings) throw new WorkReadUnavailable('Reader rating inventory is unavailable');
  const ratings = await session.deps.libraryRatings.read(session, currentMains, realm);
  if (await status.fence(agent) !== statusFence
    || await session.deps.profiles?.agentFence(agent) !== before
    || !await session.deps.access.canReadAsBaselineMember?.(session.principal, agent)) {
    throw new WorkReadMoved('Reader library changed');
  }
  return { profile: 'reader-work-state-batch-v1' as const,
    items: states.map(value => ({ work: value.work, status: value,
      customShelves: shelves.get(value.work) ?? [],
      rating: ratings.get(value.work) ?? { global: null, realm: null },
      progress: progress.get(structures.get(value.work) ?? '') ?? null })), sourcePosition: session.position };
}

export async function readMyShelves(session: WorkReadSession, agent: string,
  status: ReaderLibraryStatusStore) {
  if (!session.principal) throw new WorkReadInvalid('Authentication is required');
  const before = await session.deps.profiles?.agentFence(agent);
  if (!before) throw new WorkReadMissing('Reader Agent is unavailable');
  const statusFence = await status.fence(agent);
  const limit = session.options.limit ?? 20;
  const binding = ['reader-shelves-v1', agent];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  if (cursor && !/^\d+$/.test(cursor.order)) throw new WorkReadInvalid('Invalid shelf cursor');
  const rows = await session.query(`SELECT ?id ?revision ?name ?kind ?disclosure ?structure ?sequence WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?id a rv:Collection ; rv:curator ${iri(agent)} ; rv:collectionState rv:Active ;
        rv:disclosure ?disclosure ; rv:collectionHead ?revision ; schema:name ?name ;
        rv:collectionKind ?kind ; rv:structure ?structure .
      ?structure rv:structureHead ?structureRevision .
      FILTER NOT EXISTS { ?id rv:protectionHead ?protection }
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?revision a rv:CollectionRevision ; rv:component ?id .
      ?structureRevision a rv:StructureRevision ; rv:component ?structure ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision }
      FILTER NOT EXISTS { ?structureRevision a rv:ErasedRevision }
    }
    FILTER(?disclosure IN (rv:Public, rv:Private))
    ${cursor ? `FILTER(?sequence < ${cursor.order} || (?sequence = ${cursor.order}
      && STR(?id) > ${lit(cursor.after)}))` : ''}
  } ORDER BY DESC(?sequence) STR(?id) LIMIT ${limit + 1}`, limit + 1);
  const items = rows.slice(0, limit).map(row => {
    const kind = row.kind?.value;
    const disclosure = row.disclosure?.value;
    if (![`${RV}StaticCollection`, `${RV}CapturedCollection`].includes(kind ?? '')
      || ![`${RV}Public`, `${RV}Private`].includes(disclosure ?? '')) {
      throw new WorkReadUnavailable('Invalid Collection shelf');
    }
    return { id: row.id!.value, revision: row.revision!.value, name: row.name!.value,
      kind: kind === `${RV}StaticCollection` ? 'static' as const : 'captured' as const,
      disclosure: disclosure === `${RV}Public` ? 'public' as const : 'private' as const,
      structure: row.structure!.value, changedSequence: row.sequence!.value };
  });
  if (new Set(rows.map(row => row.id?.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Collection shelf is ambiguous');
  }
  const statusShelves = await status.shelves(agent);
  if (await status.fence(agent) !== statusFence
    || await session.deps.profiles?.agentFence(agent) !== before
    || !await session.deps.access.canReadAsBaselineMember?.(session.principal, agent)) {
    throw new WorkReadMoved('Reader library changed');
  }
  return { profile: 'reader-shelves-v1' as const, statusShelves, ...pageResult(session, items,
    rows.length > limit ? encodeReadCursor(binding, session.position,
      items.at(-1)!.id, items.at(-1)!.changedSequence) : null) };
}

export async function readStatusShelf(session: WorkReadSession, agent: string,
  statusStore: ReaderLibraryStatusStore, status: ReadingStatus, options: ShelfOptions = {}) {
  if (!session.principal) throw new WorkReadInvalid('Authentication is required');
  const before = await session.deps.profiles?.agentFence(agent);
  if (!before) throw new WorkReadMissing('Reader Agent is unavailable');
  const fence = await statusStore.fence(agent, options.sort);
  const result = await readShelfPage(session, agent, statusStore, status, options, fence, false);
  if (await statusStore.fence(agent, options.sort) !== fence || await session.deps.profiles?.agentFence(agent) !== before
    || !await session.deps.access.canReadAsBaselineMember?.(session.principal, agent)) {
    throw new WorkReadMoved('Status shelf changed');
  }
  return { profile: 'reader-status-shelf-v1' as const, status, ...result };
}
