import type { Pool, PoolClient } from 'pg';
import { DATASET, GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import type { PublicProfile } from '../realm-profile/schema.ts';
import { directorySource, type Candidate } from './source.ts';
import { REALM_DIRECTORY_COST } from './contract.ts';

export type RealmDirectorySort = 'activity' | 'members' | 'newest' | 'growing';
export interface DirectoryRow { realm: string; space: string; profile: PublicProfile | null;
  rank: string; count_value: string; count_revision: string }

/** Derived, rebuildable projection. Source updates and deletions commit with
 * their watermark; restore/erasure invalidates the projection. A cold rebuild
 * streams bounded source batches. Ordinary updates hydrate only affected Realms.
 * Activity, member and newest pages seek an ordered B-tree: O(log R + P).
 * Growing reads at most seven daily aggregate rows per Realm and sorts in SQL;
 * substring search can scan the matching order O(R). No path materializes the
 * whole directory in JS. */
export class RealmDirectoryIndex {
  constructor(private readonly pool: Pool) {}

  async invalidate(): Promise<void> {
    await this.pool.query('UPDATE access.realm_directory_position SET data_epoch = NULL WHERE singleton');
  }

  private async upsert(client: PoolClient, candidate: Candidate): Promise<void> {
    const count = candidate.profile?.count;
    await client.query(`INSERT INTO access.realm_directory
      (realm, space, profile, created, activity, search_text, count_kind, count_value, topics)
      VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7 = 'exact' THEN
        COALESCE((SELECT value FROM access.realm_member_count WHERE realm = $1),0) ELSE $8 END,$9)
      ON CONFLICT (realm) DO UPDATE SET space = EXCLUDED.space, profile = EXCLUDED.profile,
        created = EXCLUDED.created, activity = EXCLUDED.activity, search_text = EXCLUDED.search_text,
        count_kind = EXCLUDED.count_kind, count_value = EXCLUDED.count_value,
        topics = EXCLUDED.topics`,
    [candidate.id, candidate.space, candidate.profile, candidate.created.toString(),
      candidate.activity.toString(), candidate.search, count?.kind ?? 'unknown', count?.value ?? -1,
      candidate.topics]);
  }

  private async refresh(session: WorkReadSession): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = (await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
      if (!recovery?.open) throw new WorkReadUnavailable('Realm directory recovery is held');
      const prior = (await client.query<{ data_epoch: string | null; sequence: string;
        target_sequence: string | null; refresh_after: string; rebuilding: boolean }>(`
        SELECT * FROM access.realm_directory_position WHERE singleton FOR UPDATE`)).rows[0]!;
      if (prior.data_epoch === session.position.dataEpoch && prior.sequence === session.position.sequence
        && prior.target_sequence === null && !prior.rebuilding) {
        await client.query('COMMIT');
        return true;
      }
      // Count updates take this lock before touching directory rows, preventing
      // an upsert from overwriting a concurrent membership delta.
      await client.query('SELECT revision FROM access.realm_count_position WHERE singleton FOR SHARE');
      const reset = prior.data_epoch !== session.position.dataEpoch
        || BigInt(prior.sequence) > BigInt(session.position.sequence);
      const erased = !reset && !prior.rebuilding && prior.target_sequence === null
        ? await session.query(`SELECT ?receipt WHERE {
          GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:erasureId ?erasure ;
            rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?sequence .
            FILTER(?sequence > ${prior.sequence}) } } LIMIT 1`, 1) : [];
      const rebuild = reset || erased.length > 0 || prior.rebuilding;
      const starting = reset || prior.target_sequence === null;
      const target = starting ? session.position.sequence : prior.target_sequence!;
      let after = starting ? '' : prior.refresh_after;
      if (rebuild && starting) await client.query('DELETE FROM access.realm_directory');
      let complete = false;
      for (let batch = 0; batch < REALM_DIRECTORY_COST.refreshBatches; batch++) {
        session.checkDeadline();
        let ids: string[] | undefined;
        if (!rebuild) {
          const changed = await session.query(`SELECT DISTINCT ?realm WHERE {
            GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:dataEpoch ${lit(session.position.dataEpoch)} ;
              rv:sequence ?sequence . FILTER(?sequence > ${prior.sequence} && ?sequence <= ${target}) }
            { { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:realm ?realm } }
              UNION { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:space ?space }
                GRAPH ${iri(GRAPHS.current)} { ?realm rv:space ?space } }
              UNION { GRAPH ${iri(GRAPHS.receipts)} { ?receipt ?property ?work .
                VALUES ?property { rv:work rv:resource } }
                GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmPublicationSlot ; rv:realm ?realm ; rv:work ?work } } }
            FILTER(STR(?realm) > ${lit(after)})
          } ORDER BY STR(?realm) LIMIT ${REALM_DIRECTORY_COST.sourceBatch}`, REALM_DIRECTORY_COST.sourceBatch);
          ids = changed.map(row => row.realm!.value);
          if (!ids.length) { complete = true; break; }
          await client.query('DELETE FROM access.realm_directory WHERE realm = ANY($1::text[])', [ids]);
        }
        const candidates = await directorySource(session, after, ids);
        for (const candidate of candidates) await this.upsert(client, candidate);
        after = ids?.at(-1) ?? candidates.at(-1)?.id ?? after;
        if ((ids?.length ?? candidates.length) < REALM_DIRECTORY_COST.sourceBatch) { complete = true; break; }
      }
      const fence = await session.query(`SELECT ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } } } LIMIT 2`, 1);
      if (fence[0]?.sequence?.value !== session.position.sequence) throw new WorkReadMoved('Directory source changed');
      // Incomplete projections are never readable. Durable progress survives a
      // restart and arbitrary directory size; later graph writes are caught by
      // a subsequent receipt interval before any page is exposed.
      await client.query(`UPDATE access.realm_directory_position SET data_epoch=$1,
        sequence=$2, target_sequence=$3, refresh_after=$4, rebuilding=$5 WHERE singleton`,
      [session.position.dataEpoch, complete ? target : reset ? '0' : prior.sequence,
        complete ? null : target, complete ? '' : after, !complete && rebuild]);
      await client.query('COMMIT');
      return complete && target === session.position.sequence;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof WorkReadUnavailable || error instanceof WorkReadMoved) throw error;
      throw new WorkReadUnavailable('Realm directory refresh is unavailable', { cause: error });
    } finally { client.release(); }
  }

  async page(session: WorkReadSession, input: { sort: RealmDirectorySort; q: string; topic?: string; limit?: number; cursor?: string; seek?: { id: string; key: string } }) {
    const limit = input.limit ?? session.options.limit ?? REALM_DIRECTORY_COST.pageSize;
    const binding = ['realm-directory-v3', input.sort, input.q, input.topic ?? null,
      session.options.language ?? null];
    const cursor = input.seek ? { after: input.seek.id, order: input.seek.key }
      : decodeReadCursor(input.cursor ?? session.options.cursor, binding, session.position);
    if (!await this.refresh(session)) throw new WorkReadUnavailable('Realm directory is refreshing; retry');
    const column = input.sort === 'members' ? 'count_value' : input.sort === 'newest' ? 'created' : 'activity';
    const growing = input.sort === 'growing';
    const rankColumn = growing ? '-COALESCE(g.growth,0)' : `-d.${column}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const positionRow = (await client.query<{ revision: string; growth_revision: string; day: string }>(
        growing ? `SELECT p.revision::text, g.revision::text AS growth_revision,
          (now() AT TIME ZONE 'UTC')::date::text AS day
          FROM access.realm_count_position p CROSS JOIN access.realm_growth_position g
          WHERE p.singleton AND g.singleton`
          : 'SELECT revision::text FROM access.realm_count_position WHERE singleton')).rows[0];
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
      const source = (await client.query<{ data_epoch: string; sequence: string; target_sequence: string | null; rebuilding: boolean }>(
        'SELECT * FROM access.realm_directory_position WHERE singleton')).rows[0]!;
      if (source.data_epoch !== session.position.dataEpoch || source.sequence !== session.position.sequence
        || source.target_sequence !== null || source.rebuilding) {
        throw new WorkReadMoved('Realm directory source moved');
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
        ORDER BY ${rankColumn}, d.realm LIMIT $4`,
      growing ? [rank, cursor?.after ?? '', input.q, limit + 1, input.topic ?? null,
        positionRow.day, session.position.dataEpoch]
        : [rank, cursor?.after ?? '', input.q, limit + 1, input.topic ?? null])).rows;
      await client.query('COMMIT');
      const page = rows.slice(0, limit);
      return { rows: page, position, next: rows.length > limit && page.length
        ? encodeReadCursor(binding, session.position, page.at(-1)!.realm, `${position}:${page.at(-1)!.rank}`) : null };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof WorkReadMoved || error instanceof WorkReadUnavailable) throw error;
      throw new WorkReadUnavailable('Realm directory page is unavailable', { cause: error });
    } finally { client.release(); }
  }

  async fence(position: string, growing = false): Promise<void> {
    const row = (await this.pool.query<{ revision: string; growth_revision: string; day: string }>(
      growing ? `SELECT p.revision::text, g.revision::text AS growth_revision,
        (now() AT TIME ZONE 'UTC')::date::text AS day
        FROM access.realm_count_position p CROSS JOIN access.realm_growth_position g
        WHERE p.singleton AND g.singleton`
        : 'SELECT revision::text FROM access.realm_count_position WHERE singleton')).rows[0];
    const current = growing ? `${row?.revision}/${row?.growth_revision}/${row?.day}` : row?.revision;
    if (current !== position) throw new WorkReadMoved('Realm directory ranking changed');
  }
}
