import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { workRead, type ReadPosition } from '../work/read-session.ts';
import { activateHead, authorizeManager, claimLease, digest, fenceLease, inAccess,
  RecommendationMissing, RecommendationRestart, RecommendationUnavailable,
  recordReceipt, replayReceipt, requireRecoveryOpen, type ManageContext, type ReceiptKey }
  from '../recommendation/derived-generation.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';

export const ALSO_ENJOYED_COST = { ratingRows: 32, shelfRows: 64, pairWorks: 2,
  pairsPerWork: 64, pageRows: 64, leaseMs: 30_000 } as const;
const FAMILY = 'also-enjoyed';
const SCOPE = digest(['also-enjoyed-public-v1']);
type Phase = 'ratings' | 'shelves' | 'pairs' | 'complete';
interface Generation { generation_id: string; graph_epoch: string; graph_sequence: string;
  access_revision: string; content_revision: string; phase: Phase; after_key: string;
  signal_count: string; pair_count: string; state: string }
interface RatingRow { context: string; main_version: string; slot: string; observation: string; revision: string;
  work: string; agent: string | null }
interface ShelfRow { agent: string; work: string; status: 'read' | 'reading' }
export interface CoReaderCandidate { work: string; sharedReaders: number; score: number }

/** A folded source revision and whether a source change committed after that
 * fold. Writers append change rows and never lock the fence row. */
export interface AlsoEnjoyedSourceFence { revision: string; changed: boolean }
const covers = (fence: AlsoEnjoyedSourceFence, basis: string) => !fence.changed && fence.revision === basis;

/** Content shelf fence. Folding records the basis of a new generation; a shelf
 * change that has not committed yet keeps its row and outdates that basis. */
export async function alsoEnjoyedContentFence(content: Pool, fold = false): Promise<AlsoEnjoyedSourceFence> {
  const row = (await content.query<AlsoEnjoyedSourceFence>(fold
    ? 'SELECT basis::text AS revision, changed FROM reader.fold_also_enjoyed_source_changes()'
    : `SELECT revision::text, EXISTS (SELECT 1 FROM reader.also_enjoyed_source_change) AS changed
      FROM reader.also_enjoyed_source_fence WHERE id`)).rows[0];
  if (!row) throw new RecommendationUnavailable('Content shelf fence is unavailable');
  return row;
}

/** Access signal fence, read or folded inside the caller's transaction. */
export async function alsoEnjoyedAccessFence(client: PoolClient, fold = false): Promise<AlsoEnjoyedSourceFence> {
  const row = (await client.query<AlsoEnjoyedSourceFence>(fold
    ? 'SELECT basis::text AS revision, changed FROM access.fold_also_enjoyed_source_changes()'
    : `SELECT revision::text, EXISTS (SELECT 1 FROM access.also_enjoyed_source_change) AS changed
      FROM access.also_enjoyed_source_fence WHERE id`)).rows[0];
  if (!row) throw new RecommendationUnavailable('Access signal fence is unavailable');
  return row;
}

/** One snapshot spans three owners. The source fences make an old active
 * generation ineligible immediately, even before a replacement is built. */
export class AlsoEnjoyedStore {
  constructor(private readonly access: Pool, private readonly content: Pool) {}

  async authorize(context: ManageContext) {
    await inAccess(this.access, client => authorizeManager(client, context));
  }

  private async accessFence() {
    return inAccess(this.access, async client => {
      await requireRecoveryOpen(client);
      return alsoEnjoyedAccessFence(client);
    });
  }

  async register(context: ManageContext, position: ReadPosition, key: ReceiptKey) {
    const contentRevision = (await alsoEnjoyedContentFence(this.content, true)).revision;
    return inAccess(this.access, async client => {
      await requireRecoveryOpen(client);
      const principal = await authorizeManager(client, context);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`also-enjoyed-receipt:${principal}:${key.idempotencyKey}`]);
      const replay = await replayReceipt(client, principal, key, 'build');
      if (replay) return { generation: replay.generation_id, replayed: true };
      const accessRevision = (await alsoEnjoyedAccessFence(client, true)).revision;
      const generation = randomUUID();
      const manifest = { profile: 'also-enjoyed-public-v1', position,
        accessRevision, contentRevision };
      await client.query(`INSERT INTO access.derived_generation
        (id, family, scope_key, input_digest, input_manifest, lease_expires_at)
        VALUES ($1,$2,$3,$4,$5,clock_timestamp())`,
      [generation, FAMILY, SCOPE, digest(manifest), JSON.stringify(manifest)]);
      await client.query(`INSERT INTO access.also_enjoyed_generation
        (generation_id, graph_epoch, graph_sequence, access_revision, content_revision)
        VALUES ($1,$2,$3,$4,$5)`,
      [generation, position.dataEpoch, position.sequence, accessRevision, contentRevision]);
      await client.query(`INSERT INTO access.derived_generation_input
        (generation_id, source, data_epoch, pinned_sequence, checkpoint_sequence)
        VALUES ($1,'main-graph',$2,$3,$3), ($1,'access','access',$4,$4),
          ($1,'content','content',$5,$5)`,
      [generation, position.dataEpoch, position.sequence, accessRevision, contentRevision]);
      await recordReceipt(client, principal, key, { action: 'build', generation_id: generation,
        outcome: 'succeeded', head_revision: null });
      return { generation, replayed: false };
    });
  }

  async generation(id: string): Promise<Generation> {
    return inAccess(this.access, async client => {
      const row = (await client.query<Generation>(`SELECT a.*, a.graph_sequence::text,
        a.access_revision::text, a.content_revision::text, a.signal_count::text,
        a.pair_count::text, g.state FROM access.also_enjoyed_generation a
        JOIN access.derived_generation g ON g.id = a.generation_id
        WHERE a.generation_id = $1`, [id])).rows[0];
      if (!row) throw new RecommendationMissing('Co-reader generation is unavailable');
      return row;
    });
  }

  private async ratingBatch(after: string): Promise<RatingRow[]> {
    const cursor = after ? JSON.parse(after) as [string, string, string] : ['', '', ''];
    return inAccess(this.access, async client => {
      await requireRecoveryOpen(client);
      return (await client.query<RatingRow>(`WITH page AS MATERIALIZED (
        SELECT h.context, h.main_version, h.slot, h.observation, h.revision, h.work,
          h.principal_id, h.admission_id FROM access.rating_aggregate_context c
        JOIN access.rating_aggregate_head h ON h.context = c.context
        WHERE c.realm = $1 AND h.target_release IS NULL
          AND (h.context, h.main_version, h.slot) > ($2::text, $3::text, $4::text)
        ORDER BY h.context, h.main_version, h.slot LIMIT $5
      ) SELECT page.context, page.main_version, page.slot, page.observation, page.revision,
          page.work, CASE WHEN a.state = 'sealed' AND a.graph_outcome = 'succeeded'
            AND a.action = 'rating.observation.set' AND p.active
            AND provision.state = 'active' AND provision.agent_kind = 'person'
            AND v.visibility = 'public' AND s.active THEN provision.agent_id ELSE NULL END AS agent
        FROM page JOIN access.admission a ON a.id = page.admission_id
        JOIN access.principal p ON p.id = page.principal_id
        LEFT JOIN access.agent_provision provision ON provision.principal_id = page.principal_id
          AND provision.agent_id = a.acting_subject
        LEFT JOIN access.agent_library_visibility v ON v.agent_id = provision.agent_id
        LEFT JOIN access.authority_subject s ON s.id = provision.agent_id
        ORDER BY page.context, page.main_version, page.slot`,
      [GLOBAL_RATING_POPULATION_OWNER, cursor[0], cursor[1], cursor[2],
        ALSO_ENJOYED_COST.ratingRows])).rows;
    });
  }

  private async shelfBatch(after: string): Promise<ShelfRow[]> {
    const cursor = after ? JSON.parse(after) as [string, string] : ['', ''];
    return (await this.content.query<ShelfRow>(`SELECT agent, work, status
      FROM reader.library_status WHERE status IN ('read', 'reading')
        AND (agent, work) > ($1::text, $2::text)
      ORDER BY agent, work LIMIT $3`, [cursor[0], cursor[1], ALSO_ENJOYED_COST.shelfRows])).rows;
  }

  private async publicAgents(agents: string[]): Promise<Set<string>> {
    if (!agents.length) return new Set();
    return inAccess(this.access, async client => {
      const rows = (await client.query<{ agent: string }>(`SELECT provision.agent_id AS agent
        FROM access.agent_provision provision
        JOIN access.principal p ON p.id = provision.principal_id AND p.active
        JOIN access.authority_subject s ON s.id = provision.agent_id AND s.active
        JOIN access.agent_library_visibility v ON v.agent_id = provision.agent_id
          AND v.visibility = 'public'
        WHERE provision.agent_id = ANY($1::text[]) AND provision.state = 'active'
          AND provision.agent_kind = 'person'`, [agents])).rows;
      return new Set(rows.map(row => row.agent));
    });
  }

  private async ratedWorks(work: MainWorkDependencies, request: Request,
    generation: Generation, rows: RatingRow[]) {
    const candidates = rows.filter(row => row.agent);
    if (!candidates.length) return new Set<string>();
    return workRead(work, new Request(request.url), {}, async session => {
      if (session.position.dataEpoch !== generation.graph_epoch
        || session.position.sequence !== generation.graph_sequence) {
        throw new RecommendationRestart('Rating graph changed during build');
      }
      const found = await session.query(`SELECT ?observation WHERE {
        VALUES (?observation ?head) { ${candidates.map(row =>
          `(${iri(row.observation)} ${iri(row.revision)})`).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?observation rv:observationHead ?head }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:GlobalRatingObservationRevision ;
          rv:ratingAvailability rv:Available ; rv:ratingValue ?value .
          FILTER(?value >= 4) }
      } LIMIT ${candidates.length + 1}`, candidates.length);
      return new Set(found.map(row => row.observation!.value));
    });
  }

  /** One call handles at most 32 ratings, 64 shelves, or two source Works;
   * pair writes are capped at 64 per source Work after popularity ranking.
   * Every batch commits its checkpoint with its derived rows. A crash repeats
   * only the unfinished batch; the generation lease fences an older worker. */
  async advance(id: string, manager: ManageContext, work: MainWorkDependencies, request: Request) {
    await inAccess(this.access, client => authorizeManager(client, manager));
    const epoch = await inAccess(this.access, client => claimLease(client, id, ALSO_ENJOYED_COST.leaseMs));
    const generation = await this.generation(id);
    if (generation.state !== 'building') throw new RecommendationRestart('Generation is closed');
    await workRead(work, new Request(request.url, { method: 'POST' }), {}, async session => {
      if (session.position.dataEpoch !== generation.graph_epoch
        || session.position.sequence !== generation.graph_sequence) {
        throw new RecommendationRestart('Co-reader graph changed during build');
      }
    });
    if (!covers(await alsoEnjoyedContentFence(this.content), generation.content_revision)
      || !covers(await this.accessFence(), generation.access_revision)) {
      throw new RecommendationRestart('Co-reader source changed during build');
    }
    const ratings = generation.phase === 'ratings' ? await this.ratingBatch(generation.after_key) : [];
    const shelves = generation.phase === 'shelves' ? await this.shelfBatch(generation.after_key) : [];
    const visible = generation.phase === 'shelves'
      ? await this.publicAgents([...new Set(shelves.map(row => row.agent))]) : new Set<string>();
    const rated = generation.phase === 'ratings'
      ? await this.ratedWorks(work, request, generation, ratings) : new Set<string>();
    const pairWorks = generation.phase === 'pairs' ? await inAccess(this.access, async client =>
      (await client.query<{ work: string }>(`SELECT DISTINCT work FROM access.also_enjoyed_signal
        WHERE generation_id = $1 AND source_eligible AND work > $2
        ORDER BY work LIMIT $3`, [id, generation.after_key, ALSO_ENJOYED_COST.pairWorks])).rows
        .map(row => row.work)) : [];
    if (!covers(await alsoEnjoyedContentFence(this.content), generation.content_revision)) {
      throw new RecommendationRestart('Content shelves changed during build');
    }
    // The batch was read before this check. A change committing after it leaves
    // these rows at the basis and outdates the generation for the next check.
    return inAccess(this.access, async client => {
      await requireRecoveryOpen(client);
      await fenceLease(client, id, epoch, ALSO_ENJOYED_COST.leaseMs);
      if (!covers(await alsoEnjoyedAccessFence(client), generation.access_revision)) {
        throw new RecommendationRestart('Access signals changed during build');
      }
      if (generation.phase === 'ratings') {
        for (const row of ratings) if (row.agent && rated.has(row.observation)) {
          await client.query(`INSERT INTO access.also_enjoyed_signal
            (generation_id, reader_agent, work, source_eligible, candidate_eligible)
            VALUES ($1,$2,$3,true,true) ON CONFLICT (generation_id, reader_agent, work)
            DO UPDATE SET source_eligible = true, candidate_eligible = true`,
          [id, row.agent, row.work]);
        }
        await client.query(`UPDATE access.also_enjoyed_generation SET phase = $2, after_key = $3
          WHERE generation_id = $1`, [id, ratings.length < ALSO_ENJOYED_COST.ratingRows ? 'shelves' : 'ratings',
          ratings.length < ALSO_ENJOYED_COST.ratingRows ? '' : JSON.stringify([
            ratings.at(-1)!.context, ratings.at(-1)!.main_version, ratings.at(-1)!.slot])]);
      } else if (generation.phase === 'shelves') {
        for (const row of shelves) if (visible.has(row.agent)) {
          await client.query(`INSERT INTO access.also_enjoyed_signal
            (generation_id, reader_agent, work, source_eligible, candidate_eligible)
            VALUES ($1,$2,$3,true,$4) ON CONFLICT (generation_id, reader_agent, work)
            DO UPDATE SET source_eligible = true,
              candidate_eligible = access.also_enjoyed_signal.candidate_eligible OR $4`,
          [id, row.agent, row.work, row.status === 'read']);
        }
        await client.query(`UPDATE access.also_enjoyed_generation SET phase = $2, after_key = $3
          WHERE generation_id = $1`, [id, shelves.length < ALSO_ENJOYED_COST.shelfRows ? 'pairs' : 'shelves',
          shelves.length < ALSO_ENJOYED_COST.shelfRows ? '' : JSON.stringify([
            shelves.at(-1)!.agent, shelves.at(-1)!.work])]);
      } else if (generation.phase === 'pairs') {
        for (const source of pairWorks) {
          await client.query(`WITH overlap AS (
            SELECT b.work AS candidate, count(*)::integer AS shared
            FROM access.also_enjoyed_signal a JOIN access.also_enjoyed_signal b
              ON b.generation_id = a.generation_id AND b.reader_agent = a.reader_agent
                AND b.candidate_eligible AND b.work <> a.work
            WHERE a.generation_id = $1 AND a.work = $2 AND a.source_eligible
            GROUP BY b.work
          ), scored AS (
            SELECT overlap.candidate, overlap.shared,
              count(p.reader_agent)::integer AS candidate_readers
            FROM overlap JOIN access.also_enjoyed_signal p
              ON p.generation_id = $1 AND p.work = overlap.candidate
                AND p.candidate_eligible
            GROUP BY overlap.candidate, overlap.shared
          ) INSERT INTO access.also_enjoyed_pair
            (generation_id, source_work, candidate_work, shared_readers, candidate_readers, score)
          SELECT $1, $2, candidate, shared, candidate_readers,
            shared::numeric / sqrt(candidate_readers::numeric)
          FROM scored ORDER BY shared::numeric / sqrt(candidate_readers::numeric) DESC,
            candidate COLLATE "C" LIMIT $3`, [id, source, ALSO_ENJOYED_COST.pairsPerWork]);
        }
        await client.query(`UPDATE access.also_enjoyed_generation SET phase = $2, after_key = $3
          WHERE generation_id = $1`, [id, pairWorks.length < ALSO_ENJOYED_COST.pairWorks ? 'complete' : 'pairs',
          pairWorks.at(-1) ?? '']);
      }
      const next = (await client.query<Generation>(`SELECT phase, signal_count::text, pair_count::text
        FROM access.also_enjoyed_generation WHERE generation_id = $1`, [id])).rows[0]!;
      if (next.phase === 'complete') {
        await client.query(`UPDATE access.also_enjoyed_generation SET
          signal_count = (SELECT count(*) FROM access.also_enjoyed_signal WHERE generation_id = $1),
          pair_count = (SELECT count(*) FROM access.also_enjoyed_pair WHERE generation_id = $1)
          WHERE generation_id = $1`, [id]);
        const counts = (await client.query<Pick<Generation, 'signal_count' | 'pair_count'>>(`
          SELECT signal_count::text, pair_count::text FROM access.also_enjoyed_generation
          WHERE generation_id = $1`, [id])).rows[0]!;
        await client.query(`UPDATE access.derived_generation_input
          SET snapshot_complete = true, snapshot_cursor = NULL WHERE generation_id = $1`, [id]);
        await client.query(`UPDATE access.derived_generation SET state = 'ready',
          validation_digest = $2, lease_expires_at = NULL, ready_at = clock_timestamp()
          WHERE id = $1`, [id, digest([id, generation.access_revision,
          generation.content_revision, counts.signal_count, counts.pair_count])]);
        next.signal_count = counts.signal_count;
        next.pair_count = counts.pair_count;
      } else {
        await client.query(`UPDATE access.derived_generation SET lease_expires_at = clock_timestamp()
          WHERE id = $1`, [id]);
      }
      return { generation: id, phase: next.phase, signalCount: Number(next.signal_count),
        pairCount: Number(next.pair_count) };
    });
  }

  async activate(context: ManageContext, generation: string, expectedRevision: string | null,
    key: ReceiptKey, position: ReadPosition) {
    const row = await this.generation(generation);
    if (row.phase !== 'complete' || row.graph_epoch !== position.dataEpoch
      || row.graph_sequence !== position.sequence
      || !covers(await alsoEnjoyedContentFence(this.content), row.content_revision)
      || !covers(await this.accessFence(), row.access_revision)) {
      throw new RecommendationRestart('Co-reader generation source changed');
    }
    return inAccess(this.access, async client => {
      const principal = await authorizeManager(client, context);
      if (!covers(await alsoEnjoyedAccessFence(client), row.access_revision)) {
        throw new RecommendationRestart('Access signals changed');
      }
      return activateHead(client, principal, key, generation, expectedRevision);
    });
  }

  /** One indexed page of at most 64 candidates; only source Work and score
   * leave Access. Private reader identities never cross this boundary. */
  async candidates(source: string, limit: number = ALSO_ENJOYED_COST.pageRows) {
    if (limit > ALSO_ENJOYED_COST.pageRows) throw new RecommendationUnavailable('Candidate page is out of bounds');
    const contentFence = await alsoEnjoyedContentFence(this.content);
    const result = await inAccess(this.access, async client => {
      await requireRecoveryOpen(client);
      const head = (await client.query<{ generation: string; graph_epoch: string; graph_sequence: string;
        access_revision: string;
        content_revision: string }>(`SELECT a.generation_id AS generation,
          a.graph_epoch, a.graph_sequence::text, a.access_revision::text, a.content_revision::text
          FROM access.derived_generation_head h
          JOIN access.also_enjoyed_generation a ON a.generation_id = h.active_generation
          WHERE h.family = $1 AND h.scope_key = $2`, [FAMILY, SCOPE])).rows[0];
      if (!head) return { generation: null, graphEpoch: null, graphSequence: null,
        stale: false, sourceReaders: 0, rows: [] };
      if (!covers(await alsoEnjoyedAccessFence(client), head.access_revision)
        || !covers(contentFence, head.content_revision)) return { generation: null,
          graphEpoch: null, graphSequence: null, stale: true, sourceReaders: 0, rows: [] };
      const sourceReaders = Number((await client.query<{ readers: string }>(`
        SELECT count(*)::text AS readers FROM access.also_enjoyed_signal
        WHERE generation_id = $1 AND work = $2 AND source_eligible`,
      [head.generation, source])).rows[0]?.readers ?? 0);
      const rows = (await client.query<{ candidate_work: string; shared_readers: number; score: string }>(`
        SELECT candidate_work, shared_readers, score::text FROM access.also_enjoyed_pair
        WHERE generation_id = $1 AND source_work = $2
        ORDER BY score DESC, candidate_work COLLATE "C" LIMIT $3`,
      [head.generation, source, limit])).rows;
      return { generation: head.generation, graphEpoch: head.graph_epoch,
        graphSequence: head.graph_sequence, stale: false, sourceReaders, rows };
    });
    const contentAfter = await alsoEnjoyedContentFence(this.content);
    if (contentAfter.changed !== contentFence.changed || contentAfter.revision !== contentFence.revision) {
      return { generation: null, graphEpoch: null, graphSequence: null, stale: true, sourceReaders: 0,
        candidates: [] as CoReaderCandidate[] };
    }
    return { generation: result.generation, graphEpoch: result.graphEpoch,
      graphSequence: result.graphSequence, stale: result.stale,
      sourceReaders: result.sourceReaders,
      candidates: result.rows.map(row => ({ work: row.candidate_work, sharedReaders: row.shared_readers,
        score: Number(row.score) })) };
  }
}
