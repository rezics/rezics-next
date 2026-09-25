import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export class SourceIntakeInvalid extends Error {}
export class SourceIntakeConflict extends Error {}
export class SourceIntakeUnavailable extends Error {}
export class SourceProviderRateLimited extends Error {}

export interface ManualSourceIntake {
  provider: string;
  namespace: string;
  externalId: string;
  sourceRevision: string | null;
  mediaType: string;
  retention: 'retained' | 'not-retained';
  rawBytesBase64?: string;
  coverage: { scope: string; complete: boolean; omittedFields: string[] };
  rightsEvidence: {
    basis: 'unknown' | 'facts' | 'original' | 'license' | 'permission' | 'exception';
    note: string;
  };
}

export interface SourceCapture {
  profile: 'open-library-work-acquisition-v1';
  url: string;
  status: 200;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: string;
}

export interface StagedSourceObservation {
  profile: 'source-manual-intake-v1' | 'source-acquisition-v1';
  state: 'staged';
  record: string;
  observation: string;
  provider: string;
  namespace: string;
  externalId: string;
  sourceRevision: string | null;
  mediaType: string;
  retention: 'retained' | 'not-retained';
  byteDigest: string | null;
  byteLength: number | null;
  rawBytesBase64?: string;
  coverage: ManualSourceIntake['coverage'];
  rightsEvidence: ManualSourceIntake['rightsEvidence'];
  submittedAt: string;
  capture?: SourceCapture;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function checkedText(value: string, max: number): void {
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SourceIntakeInvalid('invalid source field');
  }
}

function checkedInput(input: ManualSourceIntake): { bytes: Buffer | null; digest: string | null } {
  checkedText(input.provider, 100);
  checkedText(input.namespace, 100);
  checkedText(input.externalId, 500);
  checkedText(input.mediaType, 100);
  if (input.sourceRevision !== null) checkedText(input.sourceRevision, 200);
  if (!input.coverage || typeof input.coverage.complete !== 'boolean'
    || typeof input.coverage.scope !== 'string' || !Array.isArray(input.coverage.omittedFields)) {
    throw new SourceIntakeInvalid('invalid source coverage');
  }
  checkedText(input.coverage.scope, 200);
  if (input.coverage.omittedFields.length > 64 || input.coverage.omittedFields.some(
    field => typeof field !== 'string' || field.length > 100 || !FIELD.test(field))) {
    throw new SourceIntakeInvalid('invalid omitted fields');
  }
  if (new Set(input.coverage.omittedFields).size !== input.coverage.omittedFields.length) {
    throw new SourceIntakeInvalid('duplicate omitted field');
  }
  if (!input.rightsEvidence || !['unknown', 'facts', 'original', 'license', 'permission', 'exception']
    .includes(input.rightsEvidence.basis) || typeof input.rightsEvidence.note !== 'string'
    || input.rightsEvidence.note.length > 1024) {
    throw new SourceIntakeInvalid('invalid rights evidence');
  }
  if (input.retention === 'not-retained') {
    if (input.rawBytesBase64 !== undefined) {
      throw new SourceIntakeInvalid('non-retained source cannot include raw bytes');
    }
    return { bytes: null, digest: null };
  }
  if (input.retention !== 'retained' || typeof input.rawBytesBase64 !== 'string'
    || input.rawBytesBase64.length > 87_384
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.rawBytesBase64)) {
    throw new SourceIntakeInvalid('invalid retained source bytes');
  }
  const bytes = Buffer.from(input.rawBytesBase64, 'base64');
  if (bytes.length > 65_536 || bytes.toString('base64') !== input.rawBytesBase64) {
    throw new SourceIntakeInvalid('invalid retained source bytes');
  }
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

export function manualSourceIntakeDigest(input: ManualSourceIntake): string {
  const checked = checkedInput(input);
  return createHash('sha256').update(JSON.stringify({ family: 'source-manual-intake-v1',
    provider: input.provider, namespace: input.namespace, externalId: input.externalId,
    sourceRevision: input.sourceRevision, mediaType: input.mediaType,
    retention: input.retention, byteDigest: checked.digest,
    coverage: input.coverage, rightsEvidence: input.rightsEvidence })).digest('hex');
}

interface ObservationRow {
  record_id: string; observation_id: string; provider: string; namespace: string;
  external_id: string; source_revision: string | null; media_type: string;
  retention: 'retained' | 'not-retained'; byte_digest: string | null;
  byte_length: number | null; raw_bytes: Buffer | null;
  coverage: ManualSourceIntake['coverage'];
  rights_evidence: ManualSourceIntake['rightsEvidence']; submitted_at: Date;
  capture: SourceCapture | Record<string, never>;
}

function result(row: ObservationRow): StagedSourceObservation {
  if (row.retention === 'retained' && (!row.raw_bytes || row.byte_digest !== createHash('sha256')
    .update(row.raw_bytes).digest('hex'))) {
    throw new SourceIntakeUnavailable('retained source bytes are unavailable');
  }
  if (row.retention === 'not-retained' && (row.raw_bytes || row.byte_digest)) {
    throw new SourceIntakeUnavailable('non-retained source has inconsistent bytes');
  }
  return { profile: Object.keys(row.capture).length ? 'source-acquisition-v1' : 'source-manual-intake-v1',
    state: 'staged',
    record: `https://rezics.com/id/${row.record_id}`,
    observation: `https://rezics.com/id/${row.observation_id}`,
    provider: row.provider, namespace: row.namespace, externalId: row.external_id,
    sourceRevision: row.source_revision, mediaType: row.media_type,
    retention: row.retention, byteDigest: row.byte_digest, byteLength: row.byte_length,
    ...(row.raw_bytes ? { rawBytesBase64: row.raw_bytes.toString('base64') } : {}),
    coverage: row.coverage, rightsEvidence: row.rights_evidence,
    submittedAt: row.submitted_at.toISOString(),
    ...(Object.keys(row.capture).length ? { capture: row.capture as SourceCapture } : {}) };
}

async function readRow(client: PoolClient, principalId: string,
  observationId: string): Promise<ObservationRow | null> {
  const response = await client.query<ObservationRow>(`
    SELECT r.id AS record_id, o.id AS observation_id, r.provider, r.namespace,
      r.external_id, o.source_revision, o.media_type, o.retention, o.byte_digest,
      octet_length(o.raw_bytes) AS byte_length, o.raw_bytes, o.coverage, o.rights_evidence,
      o.submitted_at, o.capture
    FROM source.observation o JOIN source.record r ON r.id = o.record_id
    WHERE o.id = $1 AND o.principal_id = $2`, [observationId, principalId]);
  return response.rows[0] ?? null;
}

export class SourceIntakeStore {
  constructor(private readonly pool: Pool) {}

  async reserveOpenLibrarySlot(): Promise<void> {
    const client = await this.pool.connect();
    let delayMs = 0;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query(`INSERT INTO source.provider_rate_gate (provider, next_at)
        VALUES ('open-library', clock_timestamp()) ON CONFLICT (provider) DO NOTHING`);
      const gate = await client.query<{ delay_ms: number }>(`
        SELECT GREATEST(0, EXTRACT(EPOCH FROM (next_at - clock_timestamp())) * 1000)::float8
          AS delay_ms FROM source.provider_rate_gate
        WHERE provider = 'open-library' FOR UPDATE`);
      delayMs = gate.rows[0]?.delay_ms ?? 0;
      if (delayMs > 3_000) throw new SourceProviderRateLimited('Open Library request queue is full');
      await client.query(`UPDATE source.provider_rate_gate
        SET next_at = GREATEST(next_at, clock_timestamp()) + interval '1 second'
        WHERE provider = 'open-library'`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    if (delayMs > 0) await Bun.sleep(delayMs);
  }

  async replay(principalId: string, idempotencyKey: string): Promise<StagedSourceObservation | null> {
    if (!UUID.test(principalId) || !idempotencyKey || idempotencyKey.length > 200) {
      throw new SourceIntakeInvalid('invalid source intake identity');
    }
    const client = await this.pool.connect();
    try {
      const prior = await client.query<{ observation_id: string }>(
        `SELECT observation_id FROM source.intake_receipt
         WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, idempotencyKey]);
      if (!prior.rows[0]) return null;
      const row = await readRow(client, principalId, prior.rows[0].observation_id);
      if (!row) throw new SourceIntakeUnavailable('source intake receipt lost its observation');
      return result(row);
    } finally { client.release(); }
  }

  async submit(principalId: string, idempotencyKey: string,
    input: ManualSourceIntake, capture?: SourceCapture):
    Promise<{ observation: StagedSourceObservation; replayed: boolean }> {
    if (!UUID.test(principalId) || !idempotencyKey || idempotencyKey.length > 200) {
      throw new SourceIntakeInvalid('invalid source intake identity');
    }
    const { bytes, digest: byteDigest } = checkedInput(input);
    if (capture && (capture.profile !== 'open-library-work-acquisition-v1'
      || capture.status !== 200
      || !/^https:\/\/openlibrary\.org\/works\/OL[1-9][0-9]{0,11}W\.json$/.test(capture.url)
      || input.provider !== 'open-library' || input.namespace !== 'work'
      || capture.url !== `https://openlibrary.org/works/${input.externalId}.json`
      || input.retention !== 'retained'
      || !Number.isFinite(Date.parse(capture.fetchedAt))
      || [capture.etag, capture.lastModified].some(value => value !== null
        && (typeof value !== 'string' || value.length > 200)))) {
      throw new SourceIntakeInvalid('invalid source capture metadata');
    }
    const manualDigest = manualSourceIntakeDigest(input);
    const requestDigest = capture ? createHash('sha256').update(JSON.stringify({
      family: 'source-acquisition-v1', manualDigest, capture })).digest('hex') : manualDigest;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [principalId, idempotencyKey]);
      const prior = await client.query<{ request_digest: string; observation_id: string }>(
        `SELECT request_digest, observation_id FROM source.intake_receipt
         WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== requestDigest) throw new SourceIntakeConflict('source intake key changed intent');
        const row = await readRow(client, principalId, prior.rows[0].observation_id);
        if (!row) throw new SourceIntakeUnavailable('source intake receipt lost its observation');
        await client.query('COMMIT');
        return { observation: result(row), replayed: true };
      }
      await client.query(`INSERT INTO source.record (id, provider, namespace, external_id)
        VALUES ($1, $2, $3, $4) ON CONFLICT (provider, namespace, external_id) DO NOTHING`,
      [Bun.randomUUIDv7(), input.provider, input.namespace, input.externalId]);
      const record = await client.query<{ id: string }>(`SELECT id FROM source.record
        WHERE provider = $1 AND namespace = $2 AND external_id = $3`,
      [input.provider, input.namespace, input.externalId]);
      if (!record.rows[0]) throw new SourceIntakeUnavailable('source record is unavailable');
      const observationId = Bun.randomUUIDv7();
      await client.query(`INSERT INTO source.observation
        (id, record_id, principal_id, source_revision, media_type, retention,
         raw_bytes, byte_digest, coverage, rights_evidence, capture)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [observationId, record.rows[0].id, principalId, input.sourceRevision,
        input.mediaType, input.retention, bytes, byteDigest,
        JSON.stringify(input.coverage), JSON.stringify(input.rightsEvidence),
        JSON.stringify(capture ?? {})]);
      await client.query(`INSERT INTO source.intake_receipt
        (principal_id, idempotency_key, request_digest, observation_id)
        VALUES ($1, $2, $3, $4)`, [principalId, idempotencyKey, requestDigest, observationId]);
      const row = await readRow(client, principalId, observationId);
      if (!row) throw new SourceIntakeUnavailable('source observation is unavailable');
      await client.query('COMMIT');
      return { observation: result(row), replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async read(principalId: string, observationId: string): Promise<StagedSourceObservation | null> {
    if (!UUID.test(principalId) || !UUID.test(observationId)) {
      throw new SourceIntakeInvalid('invalid source identity');
    }
    const client = await this.pool.connect();
    try { return await readRow(client, principalId, observationId).then(row => row ? result(row) : null); }
    finally { client.release(); }
  }
}
