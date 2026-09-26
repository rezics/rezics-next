import type { Pool } from 'pg';
import { NpmResolutionInvalid, npmSha, npmStable, validateNpmSnapshot,
  type NpmOutcome, type NpmRequest } from './npm-lock.ts';
import { validateNpmPlatformSnapshot, type NpmPlatformOutcome, type NpmPlatformRequest } from './npm-platform.ts';
import { validateNpmIdentitySnapshot, type NpmIdentityOutcome, type NpmIdentityRequest } from './npm-identity.ts';
import { validateNpmCompositionSnapshot, type NpmCompositionOutcome, type NpmCompositionRequest } from './npm-composition.ts';
export { NpmResolutionInvalid } from './npm-lock.ts';
export class NpmResolutionConflict extends Error {}
export class NpmResolutionUnavailable extends Error {}
export type NpmSnapshotRequest = NpmRequest | NpmPlatformRequest | NpmIdentityRequest | NpmCompositionRequest;
type NpmSnapshotOutcome = NpmOutcome | NpmPlatformOutcome | NpmIdentityOutcome | NpmCompositionOutcome;
export interface NpmResolution { profile: 'npm-lock-topology-receipt-v1' | 'npm-lock-topology-receipt-v2' | 'npm-lock-topology-receipt-v3' | 'npm-lock-topology-receipt-v4';
  resolution: string; requestDigest: string; request: NpmSnapshotRequest;
  outcome: NpmSnapshotOutcome; createdAt: string }
interface Row { id: string; principal_id: string; idempotency_key: string;
  request_digest: string; request: NpmSnapshotRequest; outcome: NpmSnapshotOutcome; created_at: Date }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
function validate(request: NpmSnapshotRequest) {
  return request?.profile === 'npm-lock-v3-topology-v4' ? validateNpmCompositionSnapshot(request)
    : request?.profile === 'npm-lock-v3-topology-v3' ? validateNpmIdentitySnapshot(request)
    : request?.profile === 'npm-lock-v3-topology-v2'
    ? validateNpmPlatformSnapshot(request) : validateNpmSnapshot(request);
}
export class NpmResolutionStore {
  constructor(private readonly pool: Pool) {}
  private verified(row: Row): NpmResolution {
    try {
      if (row.request_digest !== npmSha(npmStable(row.request))
        || npmStable(row.outcome) !== npmStable(validate(row.request))) {
        throw new Error('stored npm receipt differs from its snapshot');
      }
      return { profile: row.request.profile === 'npm-lock-v3-topology-v4' ? 'npm-lock-topology-receipt-v4'
        : row.request.profile === 'npm-lock-v3-topology-v3' ? 'npm-lock-topology-receipt-v3'
        : row.request.profile === 'npm-lock-v3-topology-v2'
        ? 'npm-lock-topology-receipt-v2' : 'npm-lock-topology-receipt-v1', resolution: `https://rezics.com/id/${row.id}`,
        requestDigest: row.request_digest, request: row.request, outcome: row.outcome,
        createdAt: row.created_at.toISOString() };
    } catch { throw new NpmResolutionUnavailable('stored npm receipt evidence is unavailable'); }
  }
  async resolve(principalId: string, key: string, request: NpmSnapshotRequest):
    Promise<{ resolution: NpmResolution; replayed: boolean }> {
    if (!UUID.test(principalId) || !KEY.test(key)) throw new NpmResolutionInvalid('invalid npm resolution key');
    const outcome = validate(request);
    const digest = npmSha(npmStable(request));
    const inserted = await this.pool.query(`INSERT INTO pkg.npm_resolution
      (id, principal_id, idempotency_key, request_digest, request, outcome)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (principal_id, idempotency_key) DO NOTHING`,
    [Bun.randomUUIDv7(), principalId, key, digest, JSON.stringify(request), JSON.stringify(outcome)]);
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.npm_resolution
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (!row || row.request_digest !== digest) throw new NpmResolutionConflict('npm key binds another snapshot');
    return { resolution: this.verified(row), replayed: inserted.rowCount === 0 };
  }
  async read(principalId: string, id: string): Promise<NpmResolution | null> {
    if (!UUID.test(principalId) || !UUID.test(id)) throw new NpmResolutionInvalid('invalid npm resolution identity');
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.npm_resolution
      WHERE id = $1 AND principal_id = $2`, [id, principalId])).rows[0];
    return row ? this.verified(row) : null;
  }
}
