import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export class SourceScoreInvalid extends Error {}
export class SourceScoreConflict extends Error {}
export class SourceScoreUnavailable extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IRI = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const id = (value: string) => IRI.exec(value)?.[1] ?? (UUID.test(value) ? value : null);
const iri = (value: string) => `https://rezics.com/id/${value}`;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export interface SourceStatistic {
  profile: 'source-statistic-v1'; state: 'recorded'; statistic: string;
  record: string; observation: string; kind: 'aggregate-score' | 'provider-user-score';
  scorePointer: string; userPointer: string | null; providerUserKey: string | null;
  score: string; observationDigest: string; nativeEffect: 'none'; createdAt: string;
}
interface Row {
  id: string; principal_id: string; record_id: string; observation_id: string;
  kind: SourceStatistic['kind']; score_pointer: string; user_pointer: string | null;
  provider_user_key: string | null; score: string; observation_digest: string;
  idempotency_key: string; request_digest: string; created_at: Date;
}
interface Observation {
  record_id: string; raw_bytes: Buffer | null; byte_digest: string | null;
  retention: string; coverage: { complete?: boolean }; media_type: string;
}

function pointer(root: unknown, path: string): unknown {
  if (path.length > 200 || !path.startsWith('/') || path.split('/').length > 9
    || /~(?![01])/.test(path)) throw new SourceScoreInvalid('invalid JSON pointer');
  let value = root;
  for (const token of path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]{0,5})$/.test(token)) throw new SourceScoreInvalid('invalid array pointer');
      value = value[Number(token)];
    } else if (value && typeof value === 'object' && Object.hasOwn(value, token)) {
      value = (value as Record<string, unknown>)[token];
    } else throw new SourceScoreInvalid('source statistic field is absent');
  }
  return value;
}

function scoreValue(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000
    || !Number.isInteger(value * 1_000_000)) {
    throw new SourceScoreInvalid('source score is not a bounded six-decimal number');
  }
  return value.toFixed(6);
}

function toResult(row: Row): SourceStatistic {
  return { profile: 'source-statistic-v1', state: 'recorded', statistic: iri(row.id),
    record: iri(row.record_id), observation: iri(row.observation_id), kind: row.kind,
    scorePointer: row.score_pointer, userPointer: row.user_pointer,
    providerUserKey: row.provider_user_key, score: row.score,
    observationDigest: row.observation_digest, nativeEffect: 'none',
    createdAt: row.created_at.toISOString() };
}

/** One bounded 64 KiB parse, at most eight pointer steps and indexed owner reads. */
export class SourceScoreStore {
  constructor(private readonly pool: Pool) {}

  private async observation(principalId: string, observationId: string): Promise<Observation | null> {
    return (await this.pool.query<Observation>(`SELECT record_id, raw_bytes, byte_digest,
      retention, coverage, media_type FROM source.observation WHERE id = $1 AND principal_id = $2`,
    [observationId, principalId])).rows[0] ?? null;
  }

  private capture(observation: Observation, input: { kind: SourceStatistic['kind'];
    scorePointer: string; userPointer: string | null }): { score: string; user: string | null } {
    if (observation.retention !== 'retained' || !observation.raw_bytes || !observation.byte_digest
      || !observation.coverage.complete || !/^application\/json(?:;|$)/i.test(observation.media_type)
      || hash(observation.raw_bytes) !== observation.byte_digest) {
      throw new SourceScoreUnavailable('complete retained source JSON is unavailable');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(observation.raw_bytes)); }
    catch { throw new SourceScoreInvalid('source JSON is malformed'); }
    const score = scoreValue(pointer(parsed, input.scorePointer));
    let user: string | null = null;
    if (input.kind === 'provider-user-score') {
      if (!input.userPointer) throw new SourceScoreInvalid('provider user pointer is required');
      const value = pointer(parsed, input.userPointer);
      if (typeof value !== 'string' || value.length < 1 || value.length > 200
        || /[\u0000-\u001f\u007f]/.test(value)) throw new SourceScoreInvalid('provider user key is invalid');
      user = value;
    } else if (input.kind !== 'aggregate-score' || input.userPointer !== null) {
      throw new SourceScoreInvalid('source statistic kind and pointers differ');
    }
    return { score, user };
  }

  async record(principalId: string, key: string, input: { observation: string;
    kind: SourceStatistic['kind']; scorePointer: string; userPointer: string | null }):
    Promise<{ statistic: SourceStatistic; replayed: boolean } | null> {
    const observationId = id(input.observation);
    if (!UUID.test(principalId) || !KEY.test(key) || !observationId) {
      throw new SourceScoreInvalid('invalid source statistic identity');
    }
    const observation = await this.observation(principalId, observationId);
    if (!observation) return null;
    const value = this.capture(observation, input);
    const requestDigest = hash(JSON.stringify([observationId, input.kind, input.scorePointer,
      input.userPointer, value.score, value.user]));
    try {
      const inserted = await this.pool.query(`INSERT INTO source.statistic
        (id, principal_id, record_id, observation_id, kind, score_pointer, user_pointer,
         provider_user_key, score, observation_digest, idempotency_key, request_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [Bun.randomUUIDv7(), principalId, observation.record_id, observationId, input.kind,
        input.scorePointer, input.userPointer, value.user, value.score,
        observation.byte_digest, key, requestDigest]);
      const row = (await this.pool.query<Row>(`SELECT * FROM source.statistic
        WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
      if (!row || row.request_digest !== requestDigest) {
        throw new SourceScoreConflict('source statistic key or field conflicts');
      }
      return { statistic: toResult(row), replayed: inserted.rowCount === 0 };
    } catch (error) {
      if (error instanceof SourceScoreConflict) throw error;
      if (['23505', '23514'].includes((error as { code?: string }).code ?? '')) {
        throw new SourceScoreConflict('source statistic conflicts with retained capture');
      }
      throw error;
    }
  }

  async read(principalId: string, statistic: string): Promise<SourceStatistic | null> {
    const statisticId = id(statistic);
    if (!UUID.test(principalId) || !statisticId) throw new SourceScoreInvalid('invalid source statistic identity');
    const row = (await this.pool.query<Row>(`SELECT * FROM source.statistic
      WHERE id = $1 AND principal_id = $2`, [statisticId, principalId])).rows[0];
    if (!row) return null;
    const observation = await this.observation(principalId, row.observation_id);
    if (!observation || observation.record_id !== row.record_id
      || observation.byte_digest !== row.observation_digest) {
      throw new SourceScoreUnavailable('source statistic capture is unavailable');
    }
    const value = this.capture(observation, { kind: row.kind, scorePointer: row.score_pointer,
      userPointer: row.user_pointer });
    if (value.score !== Number(row.score).toFixed(6) || value.user !== row.provider_user_key
      || row.request_digest !== hash(JSON.stringify([row.observation_id, row.kind, row.score_pointer,
        row.user_pointer, value.score, value.user]))) {
      throw new SourceScoreUnavailable('source statistic differs from retained capture');
    }
    return toResult(row);
  }
}
