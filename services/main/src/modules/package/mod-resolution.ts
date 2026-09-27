import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ModProfileInvalid, type ModOutcome, type ModRequest, solveModCaptures }
  from './mod-profile.ts';

export { ModProfileInvalid } from './mod-profile.ts';
export class ModResolutionConflict extends Error {}
export class ModResolutionUnavailable extends Error {}
export interface ModResolution {
  profile: 'mod-native-capture-receipt-v1' | 'mod-native-capture-receipt-v2';
  resolution: string;
  requestDigest: string;
  request: ModRequest;
  outcome: ModOutcome;
  createdAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
interface Row { id: string; principal_id: string; idempotency_key: string;
  request_digest: string; request: ModRequest; outcome: ModOutcome; created_at: Date }

/** One indexed insert and exact read per write; one indexed row per read. */
export class ModResolutionStore {
  constructor(private readonly pool: Pool) {}
  private verified(row: Row): ModResolution {
    if (row.request_digest !== digest(row.request)
      || stable(row.outcome) !== stable(solveModCaptures(row.request))) {
      throw new ModResolutionUnavailable('stored mod receipt differs from its capture');
    }
    return { profile: row.request.profile === 'mod-native-capture-v2'
      ? 'mod-native-capture-receipt-v2' : 'mod-native-capture-receipt-v1',
      resolution: `https://rezics.com/id/${row.id}`, requestDigest: row.request_digest,
      request: row.request, outcome: row.outcome, createdAt: row.created_at.toISOString() };
  }
  async resolve(principalId: string, key: string, request: ModRequest):
    Promise<{ resolution: ModResolution; replayed: boolean }> {
    if (!UUID.test(principalId) || !KEY.test(key)) throw new ModProfileInvalid('invalid mod key');
    const outcome = solveModCaptures(request);
    const requestDigest = digest(request);
    const inserted = await this.pool.query(`INSERT INTO pkg.mod_resolution
      (id, principal_id, idempotency_key, request_digest, request, outcome)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (principal_id, idempotency_key) DO NOTHING`,
    [Bun.randomUUIDv7(), principalId, key, requestDigest,
      JSON.stringify(request), JSON.stringify(outcome)]);
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.mod_resolution
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (!row || row.request_digest !== requestDigest) {
      throw new ModResolutionConflict('mod idempotency key binds another capture');
    }
    return { resolution: this.verified(row), replayed: inserted.rowCount === 0 };
  }
  async read(principalId: string, id: string): Promise<ModResolution | null> {
    if (!UUID.test(principalId) || !UUID.test(id)) throw new ModProfileInvalid('invalid mod identity');
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.mod_resolution
      WHERE id = $1 AND principal_id = $2`, [id, principalId])).rows[0];
    return row ? this.verified(row) : null;
  }
}
