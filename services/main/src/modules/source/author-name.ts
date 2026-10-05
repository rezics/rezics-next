import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { t } from 'elysia';
import { SourceIntakeConflict, SourceIntakeInvalid, SourceIntakeUnavailable,
  type SourceIntakeStore } from './intake.ts';
import { fetchOpenLibraryJson, OpenLibraryAcquisitionUnavailable } from './open-library.ts';
import { authorFactsWithSource, projectOpenLibraryAuthorFacts, sourceFactProvenance,
  type AuthorFacts } from './author-facts.ts';

export const AUTHOR_NAME_COST = { keys: 192, readQueries: 1, providerRequests: 1,
  searchQueries: 2, searchFenceQueries: 1,
  captureBytes: 65_536, nameCharacters: 200, statementMs: 1_000 } as const;
const authorKey = /^\/authors\/OL[1-9][0-9]{0,11}A$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uri = (id: string) => `https://rezics.com/id/${id}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const authorNameProvenance = t.Object({ ...sourceFactProvenance, field: t.Literal('/name') });
/** Adopted Works one author page lists, as `SOURCE_ADOPTION_READ_COST.authorWorks` binds them. */
export const AUTHOR_WORKS_COST = { works: 64, queries: 1, statementMs: 1_000 } as const;
export interface AuthorName { displayName: string; nameSource: {
  record: string; observation: string; revision: string; sourceRevision: string | null;
  digest: string; url: string; fetchedAt: string; basis: 'facts'; field: '/name' } }
export type AuthorNameCommand = { action: 'refresh'; expectedRevision: string | null }
  | { action: 'remove'; expectedRevision: string; reason: string };
interface Row { id: string; author_key: string; principal_id: string; request_digest: string;
  provider_revision: string | null;
  observation_id: string | null; display_name: string | null; reason: string | null;
  source_revision: string | null; record_id: string | null; byte_digest: string | null;
  capture: { url: string; fetchedAt: string } | null }
const selected = `SELECT n.*, o.record_id, o.source_revision, o.byte_digest, o.capture
  FROM source.author_name_revision n LEFT JOIN source.observation o ON o.id = n.observation_id`;

/** Only the factual /name field is projected. A missing name removes the old
 * label; malformed data, redirects and failed fetches do not imply removal.
 * Provider shape: https://openlibrary.org/dev/docs/api/authors (2026-09-28). */
export function projectOpenLibraryAuthor(key: string, value: unknown) {
  const body = value as { key?: unknown; type?: { key?: unknown }; name?: unknown; revision?: unknown } | null;
  if (!authorKey.test(key) || !body || typeof body !== 'object' || Array.isArray(body)
    || body.key !== key || body.type?.key !== '/type/author'
    || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0
    || (body.name !== undefined && (typeof body.name !== 'string'
      || !body.name.trim() || body.name.length > AUTHOR_NAME_COST.nameCharacters
      || /[\u0000-\u001f\u007f]/.test(body.name)))) {
    throw new OpenLibraryAcquisitionUnavailable('Open Library author identity or name is invalid');
  }
  return { displayName: typeof body.name === 'string' ? body.name : null,
    sourceRevision: `open-library-revision:${body.revision}` };
}

function name(row: Row): AuthorName | null {
  if (row.display_name === null) return null;
  if (!row.observation_id || !row.record_id || !row.byte_digest || !row.capture) {
    throw new SourceIntakeUnavailable('Author name provenance is incomplete');
  }
  return { displayName: row.display_name, nameSource: { record: uri(row.record_id),
    observation: uri(row.observation_id), revision: uri(row.id), sourceRevision: row.source_revision,
    digest: row.byte_digest, url: row.capture.url, fetchedAt: row.capture.fetchedAt,
    basis: 'facts', field: '/name' } };
}

/** Reads are indexed head lookups, O(K log N), never scans of observations.
 * Refresh is one rate-gated provider request, one retained capture and a CAS.
 * No provider request is made from discovery, search or Work reads. */
export class SourceAuthorNameStore {
  constructor(private readonly pool: Pool, private readonly intake: SourceIntakeStore,
    private readonly fetcher: typeof fetch = fetch) {}

  async read(author: string) {
    if (!authorKey.test(author)) throw new SourceIntakeInvalid('Invalid author key');
    const row = (await this.pool.query<Row>(`${selected}
      JOIN source.author_name_head h ON h.revision = n.id WHERE h.author_key = $1`, [author])).rows[0];
    return row ? { revision: row.id, authorKey: author,
      state: row.display_name === null ? 'removed' as const : 'available' as const, name: name(row) } : null;
  }

  /** Literal text candidates from the name index; the Work join admits credits
   * before a name contributes to any public search count or suggestion.
   * Trigram-free patterns (notably one/two CJK characters) may scan the index;
   * the 1s statement deadline and 193-row probe still apply. Prefix semantics
   * are checked after the Work join. PostgreSQL documents this index limit:
   * https://www.postgresql.org/docs/current/pgtrgm.html#PGTRGM-INDEX (2026-09-28). */
  async search(term: string, _prefix: boolean) {
    if (!term || term.length > 80) throw new SourceIntakeInvalid('Invalid author name search');
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${AUTHOR_NAME_COST.statementMs}ms'`);
      const generation = (await client.query<{ generation: string }>(
        'SELECT source.author_name_search_generation() AS generation')).rows[0]!.generation;
      const rows = (await client.query<Row>(`${selected}
        JOIN source.author_name_head h ON h.revision = n.id
        WHERE n.display_name IS NOT NULL AND lower(n.display_name) LIKE $1
        ORDER BY n.author_key LIMIT ${AUTHOR_NAME_COST.keys + 1}`, [pattern])).rows;
      if (rows.length > AUTHOR_NAME_COST.keys) throw new SourceIntakeUnavailable('Author name search exceeds its candidate bound');
      await client.query('COMMIT');
      return { names: new Map(rows.map(row => [row.author_key, name(row)!])), generation };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /**
   * The current name with the record's other facts (`author-facts.ts`), all
   * projected from the capture the head selects, so each fact carries the
   * name's provenance with its own field. One indexed head lookup reads the
   * retained bytes (≤64 KiB), whose digest is checked first. A removed name
   * shows no facts either: removal withdraws the record, not only its label.
   */
  async facts(author: string): Promise<{ name: AuthorName; facts: AuthorFacts } | null> {
    if (!authorKey.test(author)) throw new SourceIntakeInvalid('Invalid author key');
    const client = await this.pool.connect();
    let row: (Row & { raw_bytes: Buffer | null }) | undefined;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${AUTHOR_NAME_COST.statementMs}ms'`);
      row = (await client.query<Row & { raw_bytes: Buffer | null }>(`SELECT n.*, o.record_id,
        o.source_revision, o.byte_digest, o.capture, o.raw_bytes
        FROM source.author_name_revision n JOIN source.author_name_head h ON h.revision = n.id
        LEFT JOIN source.observation o ON o.id = n.observation_id WHERE h.author_key = $1`, [author])).rows[0];
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const current = row ? name(row) : null;
    if (!row || !current) return null;
    if (!row.raw_bytes || row.raw_bytes.byteLength > AUTHOR_NAME_COST.captureBytes
      || createHash('sha256').update(row.raw_bytes).digest('hex') !== row.byte_digest) {
      throw new SourceIntakeUnavailable('Author capture is unavailable');
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(row.raw_bytes));
      projectOpenLibraryAuthor(author, body);
    } catch { throw new SourceIntakeUnavailable('Author capture is unavailable'); }
    return { name: current, facts: authorFactsWithSource(projectOpenLibraryAuthorFacts(body), current.nameSource) };
  }

  /**
   * Works whose retained adoption reports this author and was not withdrawn:
   * the reverse of `SourceNativeWorkAdoptionStore.authorReferences`, which a
   * caller still reads forward to fence. One query over the GIN index on the
   * conversion's author references (Content migration 410), probing 65 rows.
   */
  async reportedWorks(author: string): Promise<{ works: string[]; complete: boolean }> {
    if (!authorKey.test(author)) throw new SourceIntakeInvalid('Invalid author key');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${AUTHOR_WORKS_COST.statementMs}ms'`);
      const rows = (await client.query<{ work: string }>(`SELECT b.work FROM source.conversion c
        JOIN source.native_work_proposal p ON p.conversion_id = c.id
        JOIN source.native_work_binding b ON b.proposal_id = p.id
        WHERE c.projection -> 'authorRefs' @> $1::jsonb
          AND NOT EXISTS (SELECT 1 FROM source.native_work_support_withdrawal w WHERE w.binding_id = b.id)
        ORDER BY b.work LIMIT ${AUTHOR_WORKS_COST.works + 1}`, [JSON.stringify([{ sourceKey: author }])])).rows;
      await client.query('COMMIT');
      return { works: rows.slice(0, AUTHOR_WORKS_COST.works).map(row => row.work),
        complete: rows.length <= AUTHOR_WORKS_COST.works };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async searchGeneration() {
    return (await this.pool.query<{ generation: string }>(
      'SELECT source.author_name_search_generation() AS generation')).rows[0]!.generation;
  }

  async batch(keys: readonly string[]): Promise<Map<string, AuthorName>> {
    if (keys.length > AUTHOR_NAME_COST.keys || keys.some(key => !authorKey.test(key))) {
      throw new SourceIntakeInvalid('Author name batch exceeds its profile');
    }
    if (!keys.length) return new Map();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${AUTHOR_NAME_COST.statementMs}ms'`);
      const rows = (await client.query<Row>(`${selected}
      JOIN source.author_name_head h ON h.revision = n.id AND h.author_key = n.author_key
      WHERE h.author_key = ANY($1::text[])`, [[...new Set(keys)]])).rows;
      await client.query('COMMIT');
      return new Map(rows.flatMap(row => { const value = name(row); return value ? [[row.author_key, value]] : []; }));
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async command(principalId: string, key: string, author: string, input: AuthorNameCommand) {
    if (!uuid.test(principalId) || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key) || !authorKey.test(author)
      || (input.expectedRevision !== null && !uuid.test(input.expectedRevision))
      || !['refresh', 'remove'].includes(input.action)
      || (input.action === 'remove' && (!input.expectedRevision || !input.reason?.trim()
        || input.reason.length > 500 || /[\u0000-\u001f\u007f]/.test(input.reason)))) {
      throw new SourceIntakeInvalid('Invalid author name command');
    }
    const requestDigest = digest(JSON.stringify([author, input.action, input.expectedRevision,
      input.action === 'remove' ? input.reason : null]));
    const result = (row: Row, replayed: boolean) => ({ revision: row.id,
      authorKey: author, state: row.display_name === null ? 'removed' as const : 'available' as const,
      name: name(row), replayed });
    const prior = (await this.pool.query<Row>(`${selected}
      WHERE n.principal_id = $1 AND n.idempotency_key = $2`, [principalId, key])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest) throw new SourceIntakeConflict('Author name intent changed');
      return result(prior, true);
    }
    let observationId: string | null = null, displayName: string | null = null;
    let sourceRevision: string | null = null;
    if (input.action === 'refresh') {
      // The capture receipt also makes recovery after capture/before-CAS repeatable.
      const captureKey = `author-name:${requestDigest}:${digest(`${principalId}:${key}`)}`;
      let observation = await this.intake.replay(principalId, captureKey);
      if (!observation) {
        await this.intake.reserveOpenLibrarySlot();
        const fetched = await fetchOpenLibraryJson(`${author}.json`, this.fetcher);
        if (!fetched.ok) throw new OpenLibraryAcquisitionUnavailable(`Author acquisition failed: ${fetched.reason}`);
        const projected = projectOpenLibraryAuthor(author, fetched.parsed);
        observation = (await this.intake.submit(principalId, captureKey, {
          provider: 'open-library', namespace: 'author', externalId: author.slice(9),
          sourceRevision: projected.sourceRevision, mediaType: 'application/json', retention: 'retained',
          rawBytesBase64: fetched.bytes.toString('base64'),
          coverage: { scope: 'open-library-author-response-v1', complete: true, omittedFields: [] },
          rightsEvidence: { basis: 'facts', note: 'Author display name (/name) is a bibliographic fact; no biography, image or compilation reuse is inferred. docs/research/source-data-rights.md' },
        }, { profile: 'open-library-author-acquisition-v1', url: fetched.url, status: 200,
          etag: fetched.etag, lastModified: fetched.lastModified, fetchedAt: fetched.fetchedAt })
          .catch(async (error: unknown) => {
            if (!(error instanceof SourceIntakeConflict)) throw error;
            const replayed = await this.intake.replay(principalId, captureKey);
            if (!replayed) throw error;
            return { observation: replayed, replayed: true };
          })).observation;
      }
      if (!observation.rawBytesBase64) throw new SourceIntakeUnavailable('Author capture is unavailable');
      const projected = projectOpenLibraryAuthor(author, JSON.parse(Buffer.from(observation.rawBytesBase64, 'base64').toString()));
      displayName = projected.displayName;
      sourceRevision = projected.sourceRevision;
      observationId = observation.observation.split('/').at(-1)!;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`source-author:${author}`]);
      const replay = (await client.query<Row>(`${selected} WHERE n.principal_id = $1 AND n.idempotency_key = $2`,
        [principalId, key])).rows[0];
      if (replay) {
        if (replay.request_digest !== requestDigest) throw new SourceIntakeConflict('Author name intent changed');
        await client.query('COMMIT');
        return result(replay, true);
      }
      const current = (await client.query<Row>(`${selected}
        JOIN source.author_name_head h ON h.revision = n.id WHERE h.author_key = $1`, [author])).rows[0];
      if ((current?.id ?? null) !== input.expectedRevision) throw new SourceIntakeConflict('Author name head changed');
      const providerRevision = sourceRevision ? sourceRevision.split(':')[1]! : current?.provider_revision ?? null;
      if (current?.provider_revision && sourceRevision
        && BigInt(providerRevision!) < BigInt(current.provider_revision)) {
        throw new SourceIntakeConflict('Author source revision moved backwards');
      }
      const id = Bun.randomUUIDv7();
      await client.query(`INSERT INTO source.author_name_revision
        (id, author_key, principal_id, idempotency_key, request_digest, predecessor, observation_id, display_name, reason, provider_revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, author, principalId, key, requestDigest,
        input.expectedRevision, observationId, displayName, input.action === 'remove' ? input.reason : null, providerRevision]);
      await client.query(`INSERT INTO source.author_name_head (author_key, revision) VALUES ($1,$2)
        ON CONFLICT (author_key) DO UPDATE SET revision = EXCLUDED.revision`, [author, id]);
      const saved = (await client.query<Row>(`${selected} WHERE n.id = $1`, [id])).rows[0]!;
      await client.query('COMMIT');
      return result(saved, false);
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw new SourceIntakeConflict('Author name intent conflicts');
      throw error;
    } finally { client.release(); }
  }
}
