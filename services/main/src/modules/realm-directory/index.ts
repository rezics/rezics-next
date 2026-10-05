import type { Pool, PoolClient } from 'pg';
import { DATASET, GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMoved, WorkReadUnavailable,
  type ReadPosition, type WorkReadSession } from '../work/read-session.ts';
import type { PublicProfile } from '../realm-profile/schema.ts';
import { directorySource, type Candidate } from './source.ts';
import { REALM_DIRECTORY_COST } from './contract.ts';

export type RealmDirectorySort = 'activity' | 'members' | 'newest' | 'growing';
/** Cause of the existing unavailable response, rather than an empty exact page. */
export class RealmDirectoryWarming extends Error {}
export interface DirectoryRow { realm: string; space: string; profile: PublicProfile | null;
  rank: string; count_value: string; count_revision: string }
interface DirectoryPosition {
  data_epoch: string | null; sequence: string; generation: number; revision: string;
  build_data_epoch: string | null; build_base_sequence: string; target_sequence: string | null;
  refresh_after: string; rebuilding: boolean; phase: 'idle' | 'clean' | 'copy' | 'graph';
}

/** Derived, rebuildable projection. Source updates and deletions commit with
 * their watermark; restore/erasure invalidates the projection. A cold rebuild
 * streams bounded source batches. Ordinary updates hydrate only affected Realms.
 * Activity, member and newest pages seek an ordered B-tree: O(log R + P).
 * Growing reads at most seven daily aggregate rows per Realm and sorts in SQL;
 * substring search can scan the matching order O(R). No path materializes the
 * whole directory in JS. */
export class RealmDirectoryIndex {
  constructor(private readonly pool: Pool) {}
  private refreshNudge: (() => void) | undefined;
  get closed(): boolean { return this.pool.ending || this.pool.ended; }
  setRefreshNudge(nudge: () => void): void { this.refreshNudge = nudge; }

  async invalidate(): Promise<void> {
    await this.pool.query(`UPDATE access.realm_directory_position SET data_epoch = NULL,
      build_data_epoch = NULL, revision = revision + 1 WHERE singleton`);
  }

  private async upsert(client: PoolClient, candidate: Candidate, generation: number): Promise<void> {
    const count = candidate.profile?.count;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`realm-count:${candidate.id}`]);
    await client.query(`INSERT INTO access.realm_directory
      (realm, space, profile, created, activity, search_text, count_kind, count_value, topics, generation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7 = 'exact' THEN
        COALESCE((SELECT value FROM access.realm_member_count WHERE realm = $1),0) ELSE $8 END,$9,$10)
      ON CONFLICT (generation,realm) DO UPDATE SET space = EXCLUDED.space, profile = EXCLUDED.profile,
        created = EXCLUDED.created, activity = EXCLUDED.activity, search_text = EXCLUDED.search_text,
        count_kind = EXCLUDED.count_kind, count_value = EXCLUDED.count_value,
        topics = EXCLUDED.topics`,
    [candidate.id, candidate.space, candidate.profile, candidate.created.toString(),
      candidate.activity.toString(), candidate.search, count?.kind ?? 'unknown', count?.value ?? -1,
      candidate.topics, generation]);
  }

  /** Background-only. All HTTP reads precede the short local transaction.
   * Competing builders compare the durable revision without waiting on a lock;
   * a losing preparation is discarded and the next tick resumes its winner. */
  async refresh(session: WorkReadSession): Promise<boolean> {
    const recovery = (await this.pool.query<{ generation: string }>(
      'SELECT generation::text FROM access.recovery_fence WHERE id AND open')).rows[0];
    if (!recovery) throw new WorkReadUnavailable('Realm directory recovery is held');
    const prior = (await this.pool.query<DirectoryPosition>(
      'SELECT * FROM access.realm_directory_position WHERE singleton')).rows[0]!;
    if (prior.data_epoch === session.position.dataEpoch && prior.sequence === session.position.sequence
      && prior.build_data_epoch === session.position.dataEpoch && prior.phase === 'idle') return true;
    let phase = prior.phase;
    let rebuilding = prior.rebuilding;
    let base = prior.build_base_sequence;
    let target = prior.target_sequence ?? session.position.sequence;
    let after = prior.refresh_after;
    const reset = prior.build_data_epoch !== session.position.dataEpoch
      || BigInt(prior.sequence) > BigInt(session.position.sequence)
      || prior.target_sequence !== null && BigInt(prior.target_sequence) > BigInt(session.position.sequence);
    if (reset || phase === 'idle') {
      const erased = !reset && prior.data_epoch === session.position.dataEpoch
        ? await this.erasures(session, prior.sequence, target) : false;
      rebuilding = reset || erased;
      phase = 'clean';
      base = prior.sequence;
      target = session.position.sequence;
      after = '';
    }
    const generation = 1 - prior.generation;
    const candidates: Candidate[] = [];
    const changed: string[] = [];
    let complete = false;
    if (phase === 'graph') {
      // An erasure while an incremental successor is building needs a full
      // rebuild, including Realms whose activity depended on the erased Work.
      if (!rebuilding && await this.erasures(session, base, target)) {
        phase = 'clean'; rebuilding = true; after = '';
      } else {
        for (let batch = 0; batch < REALM_DIRECTORY_COST.refreshBatches; batch++) {
          session.checkDeadline();
          let ids: string[] | undefined;
          if (!rebuilding) {
            const rows = await session.query(`SELECT DISTINCT ?realm WHERE {
              GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:dataEpoch ${lit(session.position.dataEpoch)} ;
                rv:sequence ?sequence . FILTER(?sequence > ${base} && ?sequence <= ${target}) }
              { { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:realm ?realm } }
                UNION { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:space ?space }
                  GRAPH ${iri(GRAPHS.current)} { ?realm rv:space ?space } }
                UNION { GRAPH ${iri(GRAPHS.receipts)} { ?receipt ?property ?work .
                  VALUES ?property { rv:work rv:resource } }
                  GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmPublicationSlot ; rv:realm ?realm ; rv:work ?work } } }
              FILTER(STR(?realm) > ${lit(after)})
            } ORDER BY STR(?realm) LIMIT ${REALM_DIRECTORY_COST.sourceBatch}`, REALM_DIRECTORY_COST.sourceBatch);
            ids = rows.map(row => row.realm!.value);
            changed.push(...ids);
            if (!ids.length) { complete = true; break; }
          }
          const batchCandidates = await directorySource(session, after, ids);
          candidates.push(...batchCandidates);
          after = ids?.at(-1) ?? batchCandidates.at(-1)?.id ?? after;
          if ((ids?.length ?? batchCandidates.length) < REALM_DIRECTORY_COST.sourceBatch) { complete = true; break; }
        }
        const fence = await session.query(`SELECT ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?sequence .
          FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } } } LIMIT 2`, 1);
        if (fence[0]?.sequence?.value !== session.position.sequence) throw new WorkReadMoved('Directory source changed');
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      if (!(await client.query(`SELECT 1 FROM access.recovery_fence WHERE id AND open
        AND generation = $1 FOR SHARE NOWAIT`, [recovery.generation])).rowCount) {
        throw new WorkReadMoved('Realm directory recovery changed');
      }
      if (!(await client.query(`SELECT 1 FROM access.realm_directory_position
        WHERE singleton AND revision = $1 FOR UPDATE NOWAIT`, [prior.revision])).rowCount) {
        throw new WorkReadMoved('Realm directory builder changed');
      }
      const batchSize = REALM_DIRECTORY_COST.sourceBatch * REALM_DIRECTORY_COST.refreshBatches;
      if (phase === 'clean') {
        const removed = await client.query(`DELETE FROM access.realm_directory WHERE (generation,realm) IN
          (SELECT generation,realm FROM access.realm_directory WHERE generation = $1 ORDER BY realm LIMIT $2)`,
        [generation, batchSize]);
        if ((removed.rowCount ?? 0) < batchSize) phase = rebuilding ? 'graph' : 'copy';
      } else if (phase === 'copy') {
        // Match membership's per-Realm lock before copying an exact count.
        // Sorted locks keep overlapping builder batches in one order.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('realm-count:' || realm,0))
          FROM (SELECT realm FROM access.realm_directory WHERE generation = $1 AND realm > $2
            ORDER BY realm LIMIT $3) batch`, [prior.generation, after, batchSize]);
        const copied = await client.query<{ realm: string }>(`INSERT INTO access.realm_directory
          (generation,realm,space,profile,created,activity,search_text,count_kind,count_value,topics)
          SELECT $1,realm,space,profile,created,activity,search_text,count_kind,
            CASE WHEN count_kind = 'exact' THEN COALESCE((SELECT value FROM access.realm_member_count c
              WHERE c.realm = access.realm_directory.realm),0) ELSE count_value END,topics
          FROM access.realm_directory WHERE generation = $2 AND realm > $3 ORDER BY realm LIMIT $4 RETURNING realm`,
        [generation, prior.generation, after, batchSize]);
        after = copied.rows.at(-1)?.realm ?? after;
        if (copied.rows.length < batchSize) { phase = 'graph'; after = ''; }
      } else {
        if (changed.length) await client.query(`DELETE FROM access.realm_directory
          WHERE generation = $1 AND realm = ANY($2::text[])`, [generation, changed]);
        for (const candidate of candidates) await this.upsert(client, candidate, generation);
      }
      const publish = complete && target === session.position.sequence;
      if (complete && !publish) { base = target; target = session.position.sequence; after = ''; rebuilding = false; }
      await client.query(`UPDATE access.realm_directory_position SET
        data_epoch = CASE WHEN $1 THEN $2 ELSE data_epoch END,
        sequence = CASE WHEN $1 THEN $3::bigint ELSE sequence END,
        generation = CASE WHEN $1 THEN $4::smallint ELSE generation END,
        build_data_epoch = $2,build_base_sequence = $5,target_sequence = $6,
        refresh_after = $7,rebuilding = $8,phase = $9,revision = revision + 1 WHERE singleton`,
      [publish, session.position.dataEpoch, target, generation, base, publish ? null : target,
        publish ? '' : after, !publish && rebuilding, publish ? 'idle' : phase]);
      await client.query('COMMIT');
      return publish;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof WorkReadUnavailable || error instanceof WorkReadMoved) throw error;
      if ((error as { code?: string }).code === '55P03') throw new WorkReadMoved('Realm directory refresh is busy');
      throw new WorkReadUnavailable('Realm directory refresh is unavailable', { cause: error });
    } finally { client.release(); }
  }

  private async erasures(session: WorkReadSession, after: string, target: string): Promise<boolean> {
    return (await session.query(`SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:erasureId ?erasure ;
        rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?sequence .
        FILTER(?sequence > ${after} && ?sequence <= ${target}) } } LIMIT 1`, 1)).length > 0;
  }

  async page(session: WorkReadSession, input: { sort: RealmDirectorySort; q: string; topic?: string; limit?: number; cursor?: string; seek?: { id: string; key: string } }) {
    const limit = input.limit ?? session.options.limit ?? REALM_DIRECTORY_COST.pageSize;
    const binding = ['realm-directory-v3', input.sort, input.q, input.topic ?? null,
      session.options.language ?? null];
    const column = input.sort === 'members' ? 'count_value' : input.sort === 'newest' ? 'created' : 'activity';
    const growing = input.sort === 'growing';
    const rankColumn = growing ? '-COALESCE(g.growth,0)' : `-d.${column}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'");
      if (!(await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open')).rowCount) {
        throw new WorkReadUnavailable('Realm directory recovery is held');
      }
      const source = (await client.query<DirectoryPosition>(
        'SELECT * FROM access.realm_directory_position WHERE singleton')).rows[0]!;
      if (!source.data_epoch || source.data_epoch !== session.position.dataEpoch) {
        this.refreshNudge?.();
        throw new WorkReadUnavailable('Realm directory is not built', {
          cause: new RealmDirectoryWarming('Realm directory is warming up'),
        });
      }
      const sourcePosition: ReadPosition = { dataEpoch: source.data_epoch, sequence: source.sequence };
      const cursor = input.seek ? { after: input.seek.id, order: input.seek.key }
        : decodeReadCursor(input.cursor ?? session.options.cursor, binding, sourcePosition);
      const positionRow = (await client.query<{ revision: string; growth_revision: string; day: string }>(
        growing ? `SELECT access.realm_count_basis() AS revision, access.realm_growth_basis() AS growth_revision,
          (now() AT TIME ZONE 'UTC')::date::text AS day
          FROM access.realm_count_position p CROSS JOIN access.realm_growth_position g
          WHERE p.singleton AND g.singleton`
          : 'SELECT access.realm_count_basis() AS revision FROM access.realm_count_position WHERE singleton')).rows[0];
      if (!positionRow) throw new WorkReadUnavailable('Realm growth basis is unavailable');
      const position = growing
        ? `${positionRow.revision}/${positionRow.growth_revision}/${positionRow.day}` : positionRow.revision;
      let rank: string | null = null;
      if (cursor) {
        const [prior, order] = cursor.order.split(':');
        if (prior !== position) throw new WorkReadMoved('Realm membership changed');
        if (!order || !/^-?\d+$/.test(order)) throw new WorkReadMoved('Realm directory cursor is unavailable');
        rank = order;
      }
      const rows = (await client.query<DirectoryRow>(`${growing ? `WITH growth AS (
        SELECT realm, SUM(members + posts) AS growth FROM access.realm_growth_day
        WHERE day BETWEEN $6::date - 6 AND $6::date
          AND (data_epoch = '' OR data_epoch = $7::text)
        GROUP BY realm)` : ''}
        SELECT d.realm, d.space, d.profile,
        (${rankColumn})::text AS rank, d.count_value::text, COALESCE(c.revision,0)::text AS count_revision
        FROM access.realm_directory d LEFT JOIN access.realm_member_count c ON c.realm = d.realm
        ${growing ? 'LEFT JOIN growth g ON g.realm = d.realm' : ''}
        WHERE ${cursor ? `(${rankColumn}, d.realm) > ($1::numeric, $2::text)` : "$1::numeric IS NULL AND $2::text = ''"}
          AND ($3::text = '' OR strpos(d.search_text, $3) > 0)
          AND ($5::text IS NULL OR d.topics @> ARRAY[$5::text])
          AND d.generation = ${growing ? '$8' : '$6'}::smallint
        ORDER BY ${rankColumn}, d.realm LIMIT $4`,
      growing ? [rank, cursor?.after ?? '', input.q, limit + 1, input.topic ?? null,
        positionRow.day, sourcePosition.dataEpoch, source.generation]
        : [rank, cursor?.after ?? '', input.q, limit + 1, input.topic ?? null, source.generation])).rows;
      await client.query('COMMIT');
      const page = rows.slice(0, limit);
      return { rows: page, position, sourcePosition, next: rows.length > limit && page.length
        ? encodeReadCursor(binding, sourcePosition, page.at(-1)!.realm, `${position}:${page.at(-1)!.rank}`) : null };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof WorkReadInvalid || error instanceof WorkReadMoved || error instanceof WorkReadUnavailable) throw error;
      throw new WorkReadUnavailable('Realm directory page is unavailable', { cause: error });
    } finally { client.release(); }
  }

  async fence(position: string, growing = false, sourcePosition?: ReadPosition): Promise<void> {
    const row = (await this.pool.query<{ revision: string; growth_revision: string; day: string }>(
      growing ? `SELECT access.realm_count_basis() AS revision, access.realm_growth_basis() AS growth_revision,
        (now() AT TIME ZONE 'UTC')::date::text AS day
        FROM access.realm_count_position p CROSS JOIN access.realm_growth_position g
        WHERE p.singleton AND g.singleton`
        : 'SELECT access.realm_count_basis() AS revision FROM access.realm_count_position WHERE singleton')).rows[0];
    const current = growing ? `${row?.revision}/${row?.growth_revision}/${row?.day}` : row?.revision;
    if (current !== position) throw new WorkReadMoved('Realm directory ranking changed');
    if (sourcePosition) {
      const source = (await this.pool.query<{ data_epoch: string | null; sequence: string }>(
        'SELECT data_epoch,sequence::text FROM access.realm_directory_position WHERE singleton')).rows[0];
      if (source?.data_epoch !== sourcePosition.dataEpoch || source.sequence !== sourcePosition.sequence) {
        throw new WorkReadMoved('Realm directory source changed');
      }
    }
  }
}
