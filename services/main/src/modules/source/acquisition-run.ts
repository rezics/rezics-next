import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SourceProviderRateLimited } from './intake.ts';
import { checkedOpenLibraryWorkId, fetchOpenLibraryJson, type OpenLibraryFetchResult } from './open-library.ts';
import type { RunCompletionOutcome, SurfaceOutcome } from './run-schema.ts';

export class SourceRunInvalid extends Error {}
export class SourceRunConflict extends Error {}
export class SourceRunBusy extends Error {}
export class SourceRunUnavailable extends Error {}

export const OPEN_LIBRARY_WORKS_RUN = 'open-library-works-run-v1';
export const OPEN_LIBRARY_TERMS = 'https://openlibrary.org/developers/api';
export const EDITION_PAGE = 25;
export const EDITION_PAGES_PER_WORK = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const RIGHTS = { basis: 'unknown', note: 'Reuse basis has not been assessed.' };

export interface OpenLibraryWorksRunRequest {
  profile: typeof OPEN_LIBRARY_WORKS_RUN;
  workIds: string[];
  editions: boolean;
  ratings: boolean;
  frontier: boolean;
}

export interface SurfacePlan {
  surface: string;
  required: boolean;
  captureLimit: number;
}

/** One provider request of a surface: the stable request key, record identity and validation. */
export interface CaptureRequest {
  requestKey: string;
  path: string;
  namespace: string;
  externalId: string;
  coverageScope: string;
  captureProfile: string;
  validate: (parsed: unknown) => string | null;
  sourceRevision?: (parsed: unknown) => string | null;
}

export interface RunCaptureView {
  ordinal: number;
  role: 'response' | 'context' | 'manifest';
  requestKey: string;
  observation: string;
  record: string;
  namespace: string;
  externalId: string;
  sourceRevision: string | null;
  retention: 'retained' | 'not-retained';
  byteDigest: string | null;
  byteLength: number | null;
  url: string;
  fetchedAt: string;
}

export interface RunSurfaceView {
  surface: string;
  required: boolean;
  captureLimit: number;
  retention: { requested: string; terms: string; effective: string; limited: boolean; termsReference: string };
  outcome: null | { outcome: SurfaceOutcome; reason: string; captureCount: number;
    captureSetDigest: string | null; detail: Record<string, unknown>; settledAt: string };
  captures: RunCaptureView[];
}

export interface SourceRunView {
  profile: 'source-acquisition-run-v1';
  run: string;
  acquisitionProfile: string;
  provider: string;
  state: 'running' | RunCompletionOutcome;
  createdAt: string;
  surfaces: RunSurfaceView[];
  completion: null | { outcome: RunCompletionOutcome; qualified: number; unqualified: number;
    failed: number; missing: number; completedAt: string };
}

/** Frozen capture reused inside a run: the exact bytes, never a refetch. */
export interface FrozenCapture { id: string; ordinal: number; requestKey: string; bytes: Buffer | null }

export interface SourceRunOptions {
  reserve: () => Promise<void>;
  fetcher?: typeof fetch;
}

const iri = (id: string) => `https://rezics.com/id/${id}`;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function checkedRunKey(principalId: string, key: string | null): string {
  if (!UUID.test(principalId)) throw new SourceRunInvalid('invalid source principal');
  if (!key || !KEY.test(key)) throw new SourceRunInvalid('invalid idempotency key');
  return key;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function checkedWorksRun(request: OpenLibraryWorksRunRequest): OpenLibraryWorksRunRequest {
  if (request.profile !== OPEN_LIBRARY_WORKS_RUN || !Array.isArray(request.workIds)
    || request.workIds.length < 1 || request.workIds.length > 8
    || new Set(request.workIds).size !== request.workIds.length) {
    throw new SourceRunInvalid('Open Library works run needs one to eight distinct Work IDs');
  }
  for (const id of request.workIds) checkedOpenLibraryWorkId(id);
  return { profile: OPEN_LIBRARY_WORKS_RUN, workIds: [...request.workIds],
    editions: request.editions === true, ratings: request.ratings === true, frontier: request.frontier === true };
}

export function worksRunSurfaces(request: OpenLibraryWorksRunRequest): SurfacePlan[] {
  const n = request.workIds.length;
  return [
    ...(request.frontier ? [{ surface: 'frontier', required: true, captureLimit: 1 }] : []),
    { surface: 'works', required: true, captureLimit: n },
    ...(request.editions ? [{ surface: 'editions', required: true, captureLimit: n * EDITION_PAGES_PER_WORK }] : []),
    // Provider scores are optional source statistics; their absence never blocks the run.
    ...(request.ratings ? [{ surface: 'ratings', required: false, captureLimit: n }] : []),
  ];
}

/** Open Library lists one entry per changed key; entries of one changeset share its numeric id. */
export function recentChangeIds(parsed: unknown): bigint[] | null {
  if (!Array.isArray(parsed)) return null;
  const ids: bigint[] = [];
  for (const item of parsed) {
    const id = objectValue(item)?.id;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) ids.push(BigInt(id));
    else if (typeof id === 'string' && /^(0|[1-9][0-9]{0,30})$/.test(id)) ids.push(BigInt(id));
    else return null;
  }
  return ids;
}

function workRequest(workId: string): CaptureRequest {
  return { requestKey: `GET /works/${workId}.json`, path: `/works/${workId}.json`, namespace: 'work',
    externalId: workId, coverageScope: 'open-library-work-response-v1',
    captureProfile: 'open-library-work-acquisition-v1',
    validate: parsed => {
      const body = objectValue(parsed);
      return body?.key === `/works/${workId}` && typeof body.title === 'string' ? null : 'identity-mismatch';
    },
    sourceRevision: parsed => {
      const revision = objectValue(parsed)?.revision;
      return Number.isSafeInteger(revision) && Number(revision) >= 0 ? `open-library-revision:${revision}` : null;
    } };
}

function editionsRequest(workId: string, page: number): CaptureRequest {
  const offset = page * EDITION_PAGE;
  return { requestKey: `GET /works/${workId}/editions.json?limit=${EDITION_PAGE}&offset=${offset}`,
    path: `/works/${workId}/editions.json?limit=${EDITION_PAGE}&offset=${offset}`, namespace: 'work-editions',
    externalId: workId, coverageScope: 'open-library-work-editions-page-v1', captureProfile: 'open-library-run-capture-v1',
    validate: parsed => {
      const body = objectValue(parsed);
      if (!body || !Number.isSafeInteger(body.size) || Number(body.size) < 0 || !Array.isArray(body.entries)
        || body.entries.length > EDITION_PAGE || body.entries.some(entry => typeof objectValue(entry)?.key !== 'string')) {
        return 'malformed';
      }
      return null;
    } };
}

function ratingsRequest(workId: string): CaptureRequest {
  return { requestKey: `GET /works/${workId}/ratings.json`, path: `/works/${workId}/ratings.json`,
    namespace: 'work-ratings', externalId: workId, coverageScope: 'open-library-work-ratings-v1',
    captureProfile: 'open-library-run-capture-v1',
    validate: parsed => objectValue(objectValue(parsed)?.summary) ? null : 'malformed' };
}

export function frontierRequest(): CaptureRequest {
  return { requestKey: 'GET /recentchanges.json?limit=1', path: '/recentchanges.json?limit=1',
    namespace: 'recent-changes', externalId: 'recentchanges', coverageScope: 'open-library-recent-changes-head-v1',
    captureProfile: 'open-library-run-capture-v1',
    validate: parsed => recentChangeIds(parsed) ? null : 'malformed' };
}

function parseBytes(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
}

interface RunRow { id: string; principal_id: string; provider: string; profile: string; request_digest: string;
  created_at: Date }

export class SourceRunStore {
  readonly fetcher: typeof fetch;

  constructor(private readonly pool: Pool, private readonly options: SourceRunOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  /** Create the run with its frozen surfaces, or return the run bound to this key. */
  async start(principalId: string, key: string, profile: string, requestDigest: string,
    surfaces: readonly SurfacePlan[]): Promise<{ runId: string; created: boolean }> {
    checkedRunKey(principalId, key);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const runId = Bun.randomUUIDv7();
      const inserted = await client.query(`INSERT INTO source.acquisition_run (id, principal_id, provider, profile,
        surface_count, idempotency_key, request_digest) VALUES ($1,$2,'open-library',$3,$4,$5,$6)
        ON CONFLICT (principal_id, idempotency_key) DO NOTHING`,
      [runId, principalId, profile, surfaces.length, key, requestDigest]);
      if (inserted.rowCount === 1) {
        for (const [ordinal, surface] of surfaces.entries()) {
          await client.query(`INSERT INTO source.acquisition_run_surface (run_id, surface, ordinal, required,
            capture_limit, requested_retention, retention_terms, terms_reference)
            VALUES ($1,$2,$3,$4,$5,'retained','permitted',$6)`,
          [runId, surface.surface, ordinal, surface.required, surface.captureLimit, OPEN_LIBRARY_TERMS]);
        }
        await client.query('COMMIT');
        return { runId, created: true };
      }
      const prior = await client.query<{ id: string; profile: string; request_digest: string }>(`SELECT id, profile,
        request_digest FROM source.acquisition_run WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key]);
      await client.query('COMMIT');
      const row = prior.rows[0];
      if (!row) throw new SourceRunUnavailable('source run receipt is unavailable');
      if (row.profile !== profile || row.request_digest !== requestDigest) {
        throw new SourceRunConflict('source run key changed intent');
      }
      return { runId: row.id, created: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /**
   * Serialize executors of one run with a session lock. The database guards remain the
   * invariant; the lock only avoids two executors fetching the same missing request.
   */
  async exclusive<T>(runId: string, body: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      const locked = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('source-run:' || $1, 0)) AS locked", [runId]);
      if (!locked.rows[0]?.locked) throw new SourceRunBusy('source run is already executing');
      try { return await body(); }
      finally {
        await client.query("SELECT pg_advisory_unlock(hashtextextended('source-run:' || $1, 0))", [runId]);
      }
    } finally { client.release(); }
  }

  async settledSurfaces(runId: string): Promise<Set<string>> {
    const rows = await this.pool.query<{ surface: string }>(
      'SELECT surface FROM source.run_surface_outcome WHERE run_id = $1', [runId]);
    return new Set(rows.rows.map(row => row.surface));
  }

  async isComplete(runId: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM source.acquisition_run_completion WHERE run_id = $1', [runId]))
      .rowCount === 1;
  }

  async frozen(runId: string, requestKey: string): Promise<FrozenCapture | null> {
    const rows = await this.pool.query<{ id: string; ordinal: number; raw_bytes: Buffer | null; byte_digest: string | null }>(
      `SELECT c.id, c.ordinal, o.raw_bytes, o.byte_digest FROM source.run_capture c
       JOIN source.observation o ON o.id = c.observation_id WHERE c.run_id = $1 AND c.request_key = $2`,
      [runId, requestKey]);
    const row = rows.rows[0];
    if (!row) return null;
    if (row.raw_bytes && sha(row.raw_bytes) !== row.byte_digest) {
      throw new SourceRunUnavailable('frozen run capture digest differs');
    }
    return { id: row.id, ordinal: row.ordinal, requestKey, bytes: row.raw_bytes };
  }

  /**
   * Reuse the frozen capture for this request or perform one gated fetch. A provider
   * failure is returned for surface settlement; it never becomes an empty capture.
   */
  async acquire(principalId: string, runId: string, surface: string, request: CaptureRequest):
    Promise<{ ok: true; capture: FrozenCapture; parsed: unknown } | { ok: false; outcome: 'failed' | 'unqualified'; reason: string }> {
    const prior = await this.frozen(runId, request.requestKey);
    if (prior) return { ok: true, capture: prior, parsed: prior.bytes ? parseBytes(prior.bytes) : undefined };
    await this.options.reserve();
    const fetched: OpenLibraryFetchResult = await fetchOpenLibraryJson(request.path, this.fetcher);
    if (!fetched.ok) return { ok: false, outcome: fetched.outcome, reason: fetched.reason };
    const invalid = request.validate(fetched.parsed);
    if (invalid) return { ok: false, outcome: 'failed', reason: invalid };
    const capture = await this.insertCapture(principalId, runId, surface, request, fetched);
    return { ok: true, capture, parsed: fetched.parsed };
  }

  private async insertCapture(principalId: string, runId: string, surface: string, request: CaptureRequest,
    fetched: Extract<OpenLibraryFetchResult, { ok: true }>): Promise<FrozenCapture> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query(`INSERT INTO source.record (id, provider, namespace, external_id)
        VALUES ($1,'open-library',$2,$3) ON CONFLICT (provider, namespace, external_id) DO NOTHING`,
      [Bun.randomUUIDv7(), request.namespace, request.externalId]);
      const record = await client.query<{ id: string }>(`SELECT id FROM source.record
        WHERE provider = 'open-library' AND namespace = $1 AND external_id = $2`, [request.namespace, request.externalId]);
      const observationId = Bun.randomUUIDv7();
      await client.query(`INSERT INTO source.observation (id, record_id, principal_id, source_revision, media_type,
        retention, raw_bytes, byte_digest, coverage, rights_evidence, capture)
        VALUES ($1,$2,$3,$4,'application/json','retained',$5,$6,$7,$8,$9)`,
      [observationId, record.rows[0]!.id, principalId, request.sourceRevision?.(fetched.parsed) ?? null,
        fetched.bytes, sha(fetched.bytes),
        JSON.stringify({ scope: request.coverageScope, complete: true, omittedFields: [] }), JSON.stringify(RIGHTS),
        JSON.stringify({ profile: request.captureProfile, url: fetched.url, status: 200, etag: fetched.etag,
          lastModified: fetched.lastModified, fetchedAt: fetched.fetchedAt,
          ...(request.captureProfile === 'open-library-work-acquisition-v1' ? {} : { run: iri(runId), surface }) })]);
      const next = await client.query<{ ordinal: number }>(`SELECT COALESCE(max(ordinal) + 1, 0)::int AS ordinal
        FROM source.run_capture WHERE run_id = $1 AND surface = $2`, [runId, surface]);
      const captureId = Bun.randomUUIDv7();
      await client.query(`INSERT INTO source.run_capture (id, run_id, surface, ordinal, role, request_key, observation_id)
        VALUES ($1,$2,$3,$4,'response',$5,$6)`,
      [captureId, runId, surface, next.rows[0]!.ordinal, request.requestKey, observationId]);
      await client.query('COMMIT');
      return { id: captureId, ordinal: next.rows[0]!.ordinal, requestKey: request.requestKey, bytes: fetched.bytes };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { constraint?: string }).constraint === 'run_capture_budget') {
        throw new SourceRunUnavailable('source run surface capture budget is exhausted');
      }
      throw error;
    } finally { client.release(); }
  }

  /** Record the one surface outcome over its exact committed capture set. */
  async settle(runId: string, surface: string, outcome: SurfaceOutcome, reason: string,
    detail: Record<string, unknown> = {}): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query(`SELECT 1 FROM source.acquisition_run_surface WHERE run_id = $1 AND surface = $2 FOR UPDATE`,
        [runId, surface]);
      const captures = await client.query<{ ordinal: number; request_key: string; byte_digest: string | null }>(
        `SELECT c.ordinal, c.request_key, o.byte_digest FROM source.run_capture c
         JOIN source.observation o ON o.id = c.observation_id
         WHERE c.run_id = $1 AND c.surface = $2 ORDER BY c.ordinal`, [runId, surface]);
      const digest = captures.rows.length ? sha(captures.rows.map(row =>
        `${row.ordinal}\t${row.request_key}\t${row.byte_digest ?? 'not-retained'}`).join('\n')) : null;
      await client.query(`INSERT INTO source.run_surface_outcome (run_id, surface, outcome, reason, capture_count,
        capture_set_digest, detail) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (run_id, surface) DO NOTHING`,
      [runId, surface, outcome, reason, captures.rows.length, digest, JSON.stringify(detail)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /** Write the terminal receipt. `completed` only when every required surface is qualified. */
  async complete(runId: string): Promise<void> {
    const rows = await this.pool.query<{ required: boolean; outcome: SurfaceOutcome | null }>(
      `SELECT s.required, o.outcome FROM source.acquisition_run_surface s
       LEFT JOIN source.run_surface_outcome o ON o.run_id = s.run_id AND o.surface = s.surface
       WHERE s.run_id = $1`, [runId]);
    const outcome: RunCompletionOutcome = rows.rows.some(row => row.outcome === null) ? 'abandoned'
      : rows.rows.some(row => row.required && row.outcome !== 'qualified') ? 'incomplete' : 'completed';
    await this.pool.query(`INSERT INTO source.acquisition_run_completion (run_id, outcome, qualified_count,
      unqualified_count, failed_count, missing_count) VALUES ($1,$2,0,0,0,0) ON CONFLICT (run_id) DO NOTHING`,
    [runId, outcome]);
  }

  async runOpenLibraryWorks(principalId: string, key: string, input: OpenLibraryWorksRunRequest):
    Promise<{ run: SourceRunView; replayed: boolean }> {
    const request = checkedWorksRun(input);
    checkedRunKey(principalId, key);
    const digest = sha(JSON.stringify(request));
    const { runId, created } = await this.start(principalId, key, OPEN_LIBRARY_WORKS_RUN, digest,
      worksRunSurfaces(request));
    if (!created && await this.isComplete(runId)) {
      return { run: (await this.read(principalId, runId))!, replayed: true };
    }
    await this.exclusive(runId, async () => {
      const settled = await this.settledSurfaces(runId);
      for (const plan of worksRunSurfaces(request)) {
        if (settled.has(plan.surface)) continue;
        await this.executeSurface(principalId, runId, plan.surface, request);
      }
      await this.complete(runId);
    });
    return { run: (await this.read(principalId, runId))!, replayed: !created };
  }

  private async executeSurface(principalId: string, runId: string, surface: string,
    request: OpenLibraryWorksRunRequest): Promise<void> {
    const fail = (outcome: 'failed' | 'unqualified', reason: string, detail: Record<string, unknown>) =>
      this.settle(runId, surface, outcome, reason, detail);
    const one = async (capture: CaptureRequest, detail: Record<string, unknown>) => {
      const result = await this.acquire(principalId, runId, surface, capture);
      if (!result.ok) { await fail(result.outcome, result.reason, { ...detail, requestKey: capture.requestKey }); }
      return result;
    };
    if (surface === 'frontier') {
      const result = await one(frontierRequest(), {});
      if (!result.ok) return;
    } else if (surface === 'editions') {
      for (const workId of request.workIds) {
        for (let page = 0; ; page++) {
          const result = await one(editionsRequest(workId, page), { workId, page });
          if (!result.ok) return;
          const size = Number(objectValue(result.parsed)?.size);
          const pages = Math.max(1, Math.ceil(size / EDITION_PAGE));
          if (pages > EDITION_PAGES_PER_WORK) {
            // A narrower capture never qualifies as the complete edition set.
            await fail('failed', 'budget-exhausted', { workId, size, maxPages: EDITION_PAGES_PER_WORK });
            return;
          }
          if (page + 1 >= pages) break;
        }
      }
    } else {
      for (const workId of request.workIds) {
        const result = await one(surface === 'works' ? workRequest(workId) : ratingsRequest(workId), { workId });
        if (!result.ok) return;
      }
    }
    await this.settle(runId, surface, 'qualified', 'complete');
  }

  async read(principalId: string, runId: string): Promise<SourceRunView | null> {
    if (!UUID.test(principalId) || !UUID.test(runId)) throw new SourceRunInvalid('invalid source run identity');
    const client = await this.pool.connect();
    try { return await readRun(client, principalId, runId); } finally { client.release(); }
  }
}

export async function readRun(client: Pick<PoolClient, 'query'>, principalId: string,
  runId: string): Promise<SourceRunView | null> {
  const run = (await client.query<RunRow>(`SELECT id, principal_id, provider, profile, request_digest, created_at
    FROM source.acquisition_run WHERE id = $1 AND principal_id = $2`, [runId, principalId])).rows[0];
  if (!run) return null;
  const surfaces = await client.query<{ surface: string; required: boolean; capture_limit: number;
    requested_retention: string; retention_terms: string; effective_retention: string; retention_limited: boolean;
    terms_reference: string; outcome: SurfaceOutcome | null; reason: string | null; capture_count: number | null;
    capture_set_digest: string | null; detail: Record<string, unknown> | null; settled_at: Date | null }>(
    `SELECT s.surface, s.required, s.capture_limit, s.requested_retention, s.retention_terms, s.effective_retention,
      s.retention_limited, s.terms_reference, o.outcome, o.reason, o.capture_count, o.capture_set_digest, o.detail,
      o.created_at AS settled_at
     FROM source.acquisition_run_surface s
     LEFT JOIN source.run_surface_outcome o ON o.run_id = s.run_id AND o.surface = s.surface
     WHERE s.run_id = $1 ORDER BY s.ordinal`, [runId]);
  const captures = await client.query<{ surface: string; ordinal: number; role: RunCaptureView['role'];
    request_key: string; observation_id: string; record_id: string; namespace: string; external_id: string;
    source_revision: string | null; retention: RunCaptureView['retention']; byte_digest: string | null;
    byte_length: number | null; url: string; fetched_at: string }>(
    `SELECT c.surface, c.ordinal, c.role, c.request_key, c.observation_id, r.id AS record_id, r.namespace,
      r.external_id, o.source_revision, o.retention, o.byte_digest, octet_length(o.raw_bytes) AS byte_length,
      o.capture ->> 'url' AS url, o.capture ->> 'fetchedAt' AS fetched_at
     FROM source.run_capture c JOIN source.observation o ON o.id = c.observation_id
     JOIN source.record r ON r.id = o.record_id
     WHERE c.run_id = $1 ORDER BY c.surface, c.ordinal`, [runId]);
  const completion = (await client.query<{ outcome: RunCompletionOutcome; qualified_count: number;
    unqualified_count: number; failed_count: number; missing_count: number; created_at: Date }>(
    'SELECT * FROM source.acquisition_run_completion WHERE run_id = $1', [runId])).rows[0];
  return { profile: 'source-acquisition-run-v1', run: iri(run.id), acquisitionProfile: run.profile,
    provider: run.provider, state: completion?.outcome ?? 'running', createdAt: run.created_at.toISOString(),
    surfaces: surfaces.rows.map(row => ({ surface: row.surface, required: row.required, captureLimit: row.capture_limit,
      retention: { requested: row.requested_retention, terms: row.retention_terms, effective: row.effective_retention,
        limited: row.retention_limited, termsReference: row.terms_reference },
      outcome: row.outcome === null ? null : { outcome: row.outcome, reason: row.reason!,
        captureCount: row.capture_count!, captureSetDigest: row.capture_set_digest, detail: row.detail ?? {},
        settledAt: row.settled_at!.toISOString() },
      captures: captures.rows.filter(capture => capture.surface === row.surface).map(capture => ({
        ordinal: capture.ordinal, role: capture.role, requestKey: capture.request_key,
        observation: iri(capture.observation_id), record: iri(capture.record_id), namespace: capture.namespace,
        externalId: capture.external_id, sourceRevision: capture.source_revision, retention: capture.retention,
        byteDigest: capture.byte_digest, byteLength: capture.byte_length, url: capture.url,
        fetchedAt: capture.fetched_at })) })),
    completion: completion ? { outcome: completion.outcome, qualified: completion.qualified_count,
      unqualified: completion.unqualified_count, failed: completion.failed_count, missing: completion.missing_count,
      completedAt: completion.created_at.toISOString() } : null };
}

export { SourceProviderRateLimited };
