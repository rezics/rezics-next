import { GRAPHS, WORK_SEMANTIC_TYPES, iri } from '../work/activate.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { decodeReadCursor, encodeReadCursor, publicWork, WorkReadMoved,
  WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';
import { RANKING_COST, rankingBuckets, type RankingInterval, type RankingMetric,
  type ReadRankingProjection } from './projection.ts';

export async function readRankings(session: WorkReadSession, projection: ReadRankingProjection,
  options: { realm: string | null; metric: RankingMetric; interval: RankingInterval;
    order: 'score' | 'growth' }) {
  if (options.realm) await readRealmBasis(session, options.realm);
  const checkpoint = await projection.current();
  const bucket = rankingBuckets(new Date(), options.interval).current;
  const binding = ['read-rankings-v1', options.realm, options.metric, options.interval,
    options.order, bucket, checkpoint.generation, checkpoint.contentSequence,
    session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const after = cursor ? { value: cursor.order, work: cursor.after } : null;
  const candidates = await projection.candidates(checkpoint.generation, options.metric,
    options.interval, bucket, options.order, after, RANKING_COST.pageCandidates);
  const ids = candidates.map(row => row.work);
  const visible = ids.length ? await session.query(`SELECT DISTINCT ?work ?main ?head WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?main ; rv:head ?head .
      ${options.realm ? `?slot a rv:RealmPublicationSlot ; rv:realm ${iri(options.realm)} ;
        rv:work ?work ; rv:mainVersion ?main ; rv:selectionHead ?selection .
        ?contribution rv:publicationHead ?decision .` : ''} }
    ${options.realm ? `GRAPH ${iri(GRAPHS.revisions)} {
      ?selection a rv:PublicationSelection ; rv:component ?slot ;
        rv:context ${iri(options.realm)} ; rv:work ?work ; rv:mainVersion ?main ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft .
      ?decision rv:disclosure rv:Public . FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }` : ''}
    ${publicWork('?work', '?main')}
  } LIMIT ${RANKING_COST.pageCandidates + 1}`, RANKING_COST.pageCandidates) : [];
  if (visible.some(row => !row.work || !row.main || !row.head || !ids.includes(row.work.value))
    || new Set(visible.map(row => row.work!.value)).size !== visible.length) {
    throw new WorkReadUnavailable('Ranking public population is ambiguous');
  }
  const heads = new Map(visible.map(row => [row.work!.value, row]));
  const limit = session.options.limit ?? RANKING_COST.pageSize;
  const page = candidates.filter(row => heads.has(row.work)).slice(0, limit);
  const last = page.length === limit ? page.at(-1) : candidates.at(-1);
  const lastIndex = last ? candidates.indexOf(last) : -1;
  const more = last !== undefined && (lastIndex < candidates.length - 1
    || candidates.length === RANKING_COST.pageCandidates);
  const summaries = await session.summaries(page.map(row => row.work));
  const serial = await readSerialSummaries(session, page.map((row, index) => ({ row, summary: summaries[index] }))
    .filter(({ summary }) => summary?.status === 'available' && summary.disclosure === 'public'
      && summary.type === 'work').map(({ row }) => row.work));
  const typeRows = page.length ? await session.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${page.map(row => iri(row.work)).join(' ')} }
    VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
  } LIMIT 161`, 160) : [];
  const types = new Map<string, string[]>();
  for (const row of typeRows) {
    if (!row.work || !row.type || !page.some(candidate => candidate.work === row.work!.value)) {
      throw new WorkReadUnavailable('Ranking Work type relation is incomplete');
    }
    types.set(row.work.value, [...(types.get(row.work.value) ?? []), row.type.value]);
  }
  const fenced = await session.summaries(page.map(row => row.work));
  const items = page.flatMap((row, index) => {
    const summary = summaries[index], again = fenced[index], head = heads.get(row.work);
    if (summary?.status !== 'available' || summary.disclosure !== 'public'
      || again?.status !== 'available' || again.disclosure !== 'public') return [];
    const facts = serial.get(row.work);
    if (!facts || !head) throw new WorkReadUnavailable('Ranking Work summary is incomplete');
    if (!Number.isSafeInteger(Number(row.score)) || !Number.isSafeInteger(Number(row.growth))) {
      throw new WorkReadUnavailable('Ranking score exceeds the public integer range');
    }
    return [{ id: row.work, revision: head.head!.value, mainVersion: head.main!.value,
      title: summary.name, cover: summary.avatar, types: (types.get(row.work) ?? []).sort(),
      ...facts, score: Number(row.score), growth: Number(row.growth) }];
  });
  if (options.realm) await readRealmBasis(session, options.realm);
  const end = await projection.current();
  if (end.generation !== checkpoint.generation || end.contentSequence !== checkpoint.contentSequence
    || rankingBuckets(new Date(), options.interval).current !== bucket) {
    throw new WorkReadMoved('Ranking changed; restart from the first page');
  }
  return { profile: options.order === 'growth' ? 'rising-v1' as const : 'read-rankings-v1' as const,
    realm: options.realm, metric: options.metric, interval: options.interval, bucket,
    sourcePosition: session.position,
    contentPosition: { dataEpoch: checkpoint.contentEpoch, sequence: checkpoint.contentSequence },
    items, count: { value: items.length, kind: 'exact-page' as const, total: null },
    nextCursor: more && last ? encodeReadCursor(binding, session.position, last.work,
      options.order === 'score' ? last.score : last.growth) : null };
}
