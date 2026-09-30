import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { READ_PREFIX, WorkReadUnavailable } from '../work/read-session.ts';
import { configureShelfMetadata, type ShelfMetadata } from './status.ts';

export const SHELF_METADATA_COST = { graphCalls: 3, graphRows: 49, sqlReads: 4,
  // A write reads one Work, one standing slot and the latest indexed progress.
  history: 'only the frozen backfill scans session commands' } as const;
export const LIBRARY_BACKFILL_COST = { batch: 24, parentRows: 3, graphCallsPerRow: 4, deadlineMs: 600_000 } as const;
const titleKey = (value: string) => value.normalize('NFKC').toLowerCase();

/** Canonical, language-independent ordering key. Cards still use live disclosure
 * and display-language reads; these private sort hints never grant authority. */
export async function readShelfMetadata(content: Pool | PoolClient, access: Pool, graph: FusekiClient,
  agent: string, work: string, includeSessionHistory = false): Promise<ShelfMetadata> {
  const rows = (await graph.query(`${READ_PREFIX} SELECT ?main ?label ?structure WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:mainVersion ?main .
      OPTIONAL { ${iri(work)} rdfs:label ?label }
      OPTIONAL { ?structure a rv:Structure ; rv:structureOf ?main ;
        rv:structureProfile rv:BookComposition ; rv:selectedGeneration ?generation .
        ?generation rv:generationState rv:Active }
    }
  } LIMIT ${SHELF_METADATA_COST.graphRows}`, 64 * 1024)).results?.bindings ?? [];
  if (rows.length === SHELF_METADATA_COST.graphRows) throw new WorkReadUnavailable('Shelf metadata exceeds batch budget');
  const mains = new Set(rows.flatMap(row => row.main ? [row.main.value] : []));
  const structures = [...new Set(rows.flatMap(row => row.structure ? [row.structure.value] : []))];
  if (mains.size > 1 || structures.length > 1) throw new WorkReadUnavailable('Shelf metadata is ambiguous');
  const labels = rows.flatMap(row => row.label ? [row.label] : []).sort((a, b) =>
    (a['xml:lang'] === 'en' ? 0 : 1) - (b['xml:lang'] === 'en' ? 0 : 1)
      || (a['xml:lang'] ?? '').localeCompare(b['xml:lang'] ?? '') || a.value.localeCompare(b.value));
  const owner = (await access.query<{ id: string; account_issuer: string; account_subject: string }>(`
    SELECT p.id, p.account_issuer, p.account_subject FROM access.agent_provision a
    JOIN access.principal p ON p.id = a.principal_id
    WHERE a.agent_id = $1 AND a.agent_kind = 'person' AND a.state = 'active' AND p.active LIMIT 2`, [agent])).rows;
  if (owner.length > 1) throw new WorkReadUnavailable('Reader owner is ambiguous');
  const principal = owner[0];
  let ownRating: number | null = null, lastReadAt: string | null = null;
  if (principal && mains.size) {
    const contexts = (await graph.query(`${READ_PREFIX} SELECT ?context WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?context a rv:GlobalRatingContext ; rv:contextState rv:Active }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (contexts.length > 1) throw new WorkReadUnavailable('Global rating Context is ambiguous');
    const heads = contexts.length ? (await access.query<{ observation: string; revision: string; context: string }>(`
      SELECT h.observation, h.revision, h.context FROM access.rating_aggregate_head h
      JOIN access.admission a ON a.id = h.admission_id
      WHERE h.principal_id = $1 AND h.work = $2 AND h.main_version = $3 AND h.context = $4
        AND h.target_release IS NULL AND a.state = 'sealed' AND a.graph_outcome = 'succeeded' LIMIT 2`,
    [principal.id, work, [...mains][0], contexts[0]!.context!.value])).rows : [];
    if (heads.length > 1) throw new WorkReadUnavailable('Global rating inventory is ambiguous');
    if (heads.length) {
      const ratings = (await graph.query(`${READ_PREFIX} SELECT ?value WHERE {
        VALUES (?observation ?revision ?context) {
          ${heads.map(head => `(${iri(head.observation)} ${iri(head.revision)} ${iri(head.context)})`).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} {
          ?context a rv:GlobalRatingContext ; rv:contextState rv:Active .
          ?observation a rv:GlobalRatingObservation ; rv:observationHead ?revision . }
        GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:ratingAvailability rv:Available ; rv:ratingValue ?value .
          FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
      } LIMIT 2`, 8192)).results?.bindings ?? [];
      if (ratings.length > 1) throw new WorkReadUnavailable('Global rating is ambiguous');
      if (ratings[0]?.value) ownRating = Number(ratings[0].value.value);
    }
    const progress = (await content.query<{ last_read_at: string | null }>(`
      SELECT max(updated_at)::text AS last_read_at FROM structure.progress
      WHERE principal_issuer = $1 AND principal_subject = $2 AND structure = ANY($3::text[])`,
    [principal.account_issuer, principal.account_subject, structures])).rows[0]!.last_read_at;
    lastReadAt = progress;
    if (includeSessionHistory) {
      // Only the one-time backfill reads immutable locator history. State-only
      // changes must not fabricate a more recent reading event.
      const locators = (await content.query<{ last_read_at: string | null }>(`
        WITH history AS (
          SELECT c.result, lag(c.result->'locators') OVER
            (PARTITION BY c.session ORDER BY (c.result->>'version')::bigint) AS previous
          FROM reader.consumption_session_command c JOIN reader.consumption_session s ON s.id=c.session
          WHERE s.principal_issuer=$1 AND s.principal_subject=$2 AND s.agent=$3 AND s.work=$4
        ) SELECT max((result->>'changedAt')::timestamptz)::text AS last_read_at FROM history
          WHERE jsonb_array_length(result->'locators') > 0
            AND result->'locators' IS DISTINCT FROM coalesce(previous,'[]'::jsonb)`,
      [principal.account_issuer, principal.account_subject, agent, work])).rows[0]!.last_read_at;
      if (locators && (!lastReadAt || Date.parse(locators) > Date.parse(lastReadAt))) lastReadAt = locators;
    }
  }
  const saved = (await content.query<{ last_read_at: string | null }>(`SELECT last_read_at::text AS last_read_at
    FROM reader.library_status WHERE agent=$1 AND work=$2`, [agent, work])).rows[0]?.last_read_at;
  if (saved && (!lastReadAt || Date.parse(saved) > Date.parse(lastReadAt))) lastReadAt = saved;
  return { titleKey: labels[0]?.value.trim() ? titleKey(labels[0].value) : null, ownRating, lastReadAt };
}

export function configureLibraryShelves(content: Pool, access: Pool, graph: FusekiClient) {
  configureShelfMetadata(content, (agent, work, transaction) => readShelfMetadata(transaction, access, graph, agent, work));
}

export interface LibraryBackfillOptions {
  signal?: AbortSignal;
  onRowError?: (row: { agent: string; work: string }, error: unknown) => void;
}

/** Background job after listening. Only migration 602's frozen rows carry the empty marker.
 * Each row commits independently, so a crash resumes without reprocessing it.
 * Failed rows retain the marker for repair/retry, but a keyset skips them this run.
 * Keep chapter tombstones and immutable command receipts; an existing nonempty
 * parent status wins, otherwise the newest chapter supplies the parent slot. */
export async function prepareLibraryShelves(content: Pool, access: Pool, graph: FusekiClient,
  options: LibraryBackfillOptions = {}) {
  configureLibraryShelves(content, access, graph);
  const onRowError = options.onRowError ?? ((row, error) => console.warn('Library shelf backfill skipped row', row, error));
  const deadline = Date.now() + LIBRARY_BACKFILL_COST.deadlineMs;
  const client = await content.connect();
  let locked = false;
  try {
    locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('library-shelves-602',0)) AS locked")).rows[0]!.locked;
    if (!locked) return;
    let after: { changed_at: string; work: string; agent: string } | undefined;
    while (true) {
      options.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new WorkReadUnavailable('Library backfill reached its ten-minute budget; restart to resume');
      const batch = (await client.query<{ agent: string; work: string; changed_at: string }>(`
        SELECT agent, work, changed_at::text FROM reader.library_status WHERE title_key = ''
          AND ($1::timestamptz IS NULL OR (changed_at, work, agent) < ($1::timestamptz, $2, $3))
        ORDER BY changed_at DESC, work DESC, agent DESC LIMIT ${LIBRARY_BACKFILL_COST.batch}`,
      [after?.changed_at ?? null, after?.work ?? null, after?.agent ?? null])).rows;
      if (!batch.length) break;
      for (const row of batch) {
        options.signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new WorkReadUnavailable('Library backfill reached its ten-minute budget; restart to resume');
        try {
          // Resolve one frozen identity so ambiguous parents cannot poison the
          // entire batch or consume another row's parent result budget.
          const parents = (await graph.query(`${READ_PREFIX} SELECT DISTINCT ?parent WHERE {
          VALUES ?child { ${iri(row.work)} }
          { GRAPH ${iri(GRAPHS.current)} { ?child schema:isPartOf ?parent } }
          UNION { GRAPH ${iri(GRAPHS.current)} {
            ?structure a rv:Structure ; rv:structureProfile rv:BookComposition ;
              rv:structureOf ?main ; rv:selectedGeneration ?generation . ?main rv:work ?parent .
            ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
              rv:occurrenceRole rv:ChapterRole ; schema:item ?child .
            FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
            FILTER NOT EXISTS { ?child schema:isPartOf ?directParent }
          } } FILTER(?child != ?parent)
        } LIMIT ${LIBRARY_BACKFILL_COST.parentRows}`, 64 * 1024)).results?.bindings ?? [];
          if (parents.length > 1) throw new WorkReadUnavailable('Legacy chapter parent is ambiguous');
          const parent = parents[0]?.parent?.value ?? row.work;
          await client.query('BEGIN');
          try {
            await client.query("SET LOCAL lock_timeout = '2s'");
            await client.query("SET LOCAL statement_timeout = '5s'");
            // Startup no longer excludes live writers. Share their slot locks
            // before reading metadata so progress/rating writes cannot be lost.
            for (const work of [...new Set([row.work, parent])].sort()) {
              await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [JSON.stringify(['library-status-work', row.agent, work])]);
            }
            const keys = await readShelfMetadata(client, access, graph, row.agent, parent, true);
            if (parent !== row.work) {
              await client.query(`INSERT INTO reader.library_status
                (agent, work, status, started_on, finished_on, version, changed_at, title_key, own_rating, last_read_at)
                SELECT agent, $3, status, started_on, finished_on, 1, changed_at, $4, $5, $6
                FROM reader.library_status WHERE agent = $1 AND work = $2 AND title_key = '' AND status IS NOT NULL
                ON CONFLICT (agent,work) DO UPDATE SET status = EXCLUDED.status, started_on = EXCLUDED.started_on,
                  finished_on = EXCLUDED.finished_on, version = reader.library_status.version + 1,
                  changed_at = EXCLUDED.changed_at, title_key = EXCLUDED.title_key,
                  own_rating = EXCLUDED.own_rating, last_read_at = EXCLUDED.last_read_at
                WHERE reader.library_status.status IS NULL`,
              [row.agent, row.work, parent, keys.titleKey, keys.ownRating, keys.lastReadAt]);
              await client.query(`UPDATE reader.library_status SET status = NULL, version = version + 1,
                title_key = NULL, own_rating = NULL, last_read_at = NULL WHERE agent = $1 AND work = $2 AND title_key = ''`,
              [row.agent, row.work]);
            } else {
              await client.query(`UPDATE reader.library_status SET title_key = $3, own_rating = $4, last_read_at = $5
                WHERE agent = $1 AND work = $2 AND title_key = ''`,
              [row.agent, row.work, keys.titleKey, keys.ownRating, keys.lastReadAt]);
            }
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK'); throw error; }
        } catch (error) { onRowError(row, error); }
      }
      after = batch.at(-1)!;
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('library-shelves-602',0))");
    client.release();
  }
}
