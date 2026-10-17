import { GRAPHS, WORK_SEMANTIC_TYPES, iri } from '../work/activate.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  publicWork,
  WorkReadMoved,
  WorkReadUnavailable,
  readDependencyToken,
  type ReadRow,
  type WorkReadSession,
} from '../work/read-session.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';
import {
  RANKING_COST,
  rankingBuckets,
  type RankingInterval,
  type RankingMetric,
  type ReadRankingProjection,
} from './projection.ts';

export async function readRankingPage(
  session: WorkReadSession,
  projection: ReadRankingProjection,
  options: {
    realm: string | null;
    metric: RankingMetric;
    interval: RankingInterval;
    order: 'score' | 'growth';
  },
) {
  if (options.realm) await readRealmBasis(session, options.realm);
  const bucket = rankingBuckets(projection.clock.at(), options.interval).current;
  const limit = session.options.limit ?? RANKING_COST.pageSize;
  let capture = await projection.capture(options.metric, options.interval, bucket,
    options.order, null, limit + 1, options.realm);
  const checkpoint = capture.checkpoint;
  const binding = [
    'read-rankings-v1',
    options.realm,
    options.metric,
    options.interval,
    options.order,
    bucket,
    session.options.language ?? null,
  ];
  // Ranking continuation follows its published population, while the graph
  // epoch remains a recovery fence. The graph's global sequence is diagnostic.
  const cursorPosition = { ...session.position,
    dependencyToken: readDependencyToken([binding, checkpoint.generation, capture.revision]) };
  const cursor = decodeReadCursor(session.options.cursor, binding, cursorPosition);
  type Candidate = typeof capture.rows[number];
  const heads = new Map<string, ReadRow>();
  if (cursor) {
    const continuation = await projection.capture(
        options.metric,
        options.interval,
        bucket,
        options.order,
        { value: cursor.order, work: cursor.after },
        limit + 1,
        options.realm,
      );
    if (continuation.checkpoint.generation !== checkpoint.generation || continuation.revision !== capture.revision) {
      throw new WorkReadMoved('Ranking population changed; restart from the first page');
    }
    capture = continuation;
  }
  const candidates = capture.rows;
  // The extra row proves continuation only; never resolve its disclosure or
  // hydrate it. A rejected row still advances the owner's ordered seek.
  const examined = candidates.slice(0, limit);
  const admitted = await (async (candidates: Candidate[]) => {
      const ids = candidates.map((row) => row.work);
      const visible = ids.length
        ? await session.query(
            `SELECT DISTINCT ?work ?main ?head WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?main ; rv:head ?head .
      ${
        options.realm
          ? `?slot a rv:RealmPublicationSlot ; rv:realm ${iri(options.realm)} ;
        rv:work ?work ; rv:mainVersion ?main ; rv:selectionHead ?selection .
        ?contribution rv:publicationHead ?decision .`
          : ''
      } }
    ${
      options.realm
        ? `GRAPH ${iri(GRAPHS.revisions)} {
      ?selection a rv:PublicationSelection ; rv:component ?slot ;
        rv:context ${iri(options.realm)} ; rv:work ?work ; rv:mainVersion ?main ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft .
      ?decision rv:disclosure rv:Public . FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }`
        : ''
    }
    ${publicWork('?work', '?main')}
  } LIMIT ${RANKING_COST.pageCandidates + 1}`,
            RANKING_COST.pageCandidates,
          )
        : [];
      if (
        visible.some(
          (row) => !row.work || !row.main || !row.head || !ids.includes(row.work.value),
        ) ||
        new Set(visible.map((row) => row.work!.value)).size !== visible.length
      ) {
        throw new WorkReadUnavailable('Ranking public population is ambiguous');
      }
      const decisions = await session.disclosure(
        visible.map((row) => ({
          owner: 'graph',
          resource: row.work!.value,
          work: row.work!.value,
          component: 'name',
          revision: row.head!.value,
          workRevision: row.head!.value,
        })),
        'read',
      );
      visible.forEach((row, index) => {
        if (decisions[index] === 'visible') heads.set(row.work!.value, row);
      });
      return candidates.filter(row => heads.has(row.work));
    })(examined);
  const selected = { page: admitted, lookahead: candidates[limit], last: examined.at(-1) };
  const page = selected.page, last = selected.last;
  const summaries = await session.summaries(page.map((row) => row.work));
  const serial = await readSerialSummaries(
    session,
    page
      .map((row, index) => ({ row, summary: summaries[index] }))
      .filter(
        ({ summary }) =>
          summary?.status === 'available' &&
          summary.disclosure === 'public' &&
          summary.type === 'work',
      )
      .map(({ row }) => row.work),
  );
  const typeRows = page.length
    ? await session.query(
        `SELECT ?work ?type WHERE {
    VALUES ?work { ${page.map((row) => iri(row.work)).join(' ')} }
    VALUES ?type { ${WORK_SEMANTIC_TYPES.map((type) => `<${type}>`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
  } LIMIT 161`,
        160,
      )
    : [];
  const types = new Map<string, string[]>();
  for (const row of typeRows) {
    if (!row.work || !row.type || !page.some((candidate) => candidate.work === row.work!.value)) {
      throw new WorkReadUnavailable('Ranking Work type relation is incomplete');
    }
    types.set(row.work.value, [...(types.get(row.work.value) ?? []), row.type.value]);
  }
  const fenced = await session.summaries(page.map((row) => row.work));
  const items = page.flatMap((row, index) => {
    const summary = summaries[index],
      again = fenced[index],
      head = heads.get(row.work);
    if (
      summary?.status !== 'available' ||
      summary.disclosure !== 'public' ||
      again?.status !== 'available' ||
      again.disclosure !== 'public'
    ) {
      return []; // Disclosure rejection is indistinguishable from an absent row.
    }
    const facts = serial.get(row.work);
    if (!facts || !head) throw new WorkReadUnavailable('Ranking Work summary is incomplete');
    if (!Number.isSafeInteger(Number(row.score)) || !Number.isSafeInteger(Number(row.growth))) {
      throw new WorkReadUnavailable('Ranking score exceeds the public integer range');
    }
    return [
      {
        id: row.work,
        revision: head.head!.value,
        mainVersion: head.main!.value,
        title: summary.name,
        cover: summary.avatar,
        types: (types.get(row.work) ?? []).sort(),
        ...facts,
        score: Number(row.score),
        growth: Number(row.growth),
      },
    ];
  });
  if (options.realm) await readRealmBasis(session, options.realm);
  if (
    !await projection.fence(capture) ||
    rankingBuckets(projection.clock.at(), options.interval).current !== bucket
  ) {
    throw new WorkReadMoved('Ranking changed; restart from the first page');
  }
  return {
    profile: options.order === 'growth' ? ('rising-v1' as const) : ('read-rankings-v1' as const),
    realm: options.realm,
    metric: options.metric,
    interval: options.interval,
    bucket,
    sourcePosition: session.position,
    contentPosition: { dataEpoch: checkpoint.contentEpoch, sequence: checkpoint.contentSequence },
    items,
    examined: examined.length,
    count: { value: items.length, kind: 'exact-page' as const, total: null },
    nextCursor:
      selected.lookahead && last
        ? encodeReadCursor(
            binding,
            cursorPosition,
            last.work,
            options.order === 'score' ? last.score : last.growth,
          )
        : null,
  };
}

/** Public Rankings publishes admitted rows only, never rejected-population counts. */
export async function readRankings(...args: Parameters<typeof readRankingPage>) {
  const { examined: _examined, ...result } = await readRankingPage(...args);
  return result;
}
