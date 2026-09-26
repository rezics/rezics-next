import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { npmRegistryLimits, npmRegistryTarballAllowed, type NpmRegistryOutcome }
  from './npm-registry.ts';
import type { NpmResolutionStore } from './npm-resolution.ts';
import { PackageArtifactStore } from './lock-artifacts.ts';
import { stableJson, type LockArtifactRow, type LockReplayArtifactRow, type LockReplayRow,
  type LockRow } from './lock-schema.ts';

export class PackageLockInvalid extends Error {}
export class PackageLockConflict extends Error {}
export class PackageLockUnavailable extends Error {}

export const PACKAGE_LOCK_PROFILE = 'rezics-package-lock-v1';
export const LOCK_REPLAY_POLICY = 'exact-artifact-replay-v1';

export interface PackageLockRequest {
  profile: typeof PACKAGE_LOCK_PROFILE;
  segments: Array<{ ecosystem: 'npm'; resolution: string;
    scope: { kind: 'process' | 'path' | 'abi'; label: string } }>;
}

export interface LockedArtifact {
  ordinal: number; segment: number; ecosystem: 'npm'; instanceKey: string;
  coordinate: { registry: string; name: string; version: string; path: string; hasInstallScript: boolean };
  locator: string; mutableReference: string | null;
  integrity: { basis: 'registry-digest'; algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'; value: string };
}

export interface PackageLockView {
  lock: string; contractVersion: typeof PACKAGE_LOCK_PROFILE; lockSha256: string;
  manifest: { contractVersion: string; lockId: string; request: PackageLockRequest;
    segments: Array<{ ordinal: number; ecosystem: 'npm'; adapterProfile: string;
      scope: { kind: string; label: string }; resolution: string; resolutionRequestDigest: string;
      environment: unknown }>;
    artifacts: LockedArtifact[]; provenance: { operation: 'package-lock-create-v1' } };
  createdAt: string;
}

export interface LockReplayView {
  replay: string; lock: string; lockSha256: string; policy: typeof LOCK_REPLAY_POLICY;
  outcome: 'verified' | 'unavailable';
  artifacts: Array<{ ordinal: number; instanceKey: string; locator: string; mutableReference: string | null;
    result: LockReplayArtifactRow['result']; observedSha256: string | null; observedByteLength: number | null;
    artifact: string | null }>;
  createdAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const REQUEST_TIMEOUT_MS = 30_000;

/** SRI -> the strongest algorithm as lowercase hex, or null when none is admitted. */
export function strongestIntegrity(integrity: string):
  { algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'; value: string } | null {
  const order = ['sha512', 'sha384', 'sha256', 'sha1'] as const;
  const found = integrity.trim().split(/\s+/)
    .map(item => /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(item.split('?')[0]!))
    .filter((match): match is RegExpExecArray => !!match)
    .map(match => {
      const algorithm = match[1] as typeof order[number];
      const decoded = Buffer.from(match[2]!, 'base64');
      const lengths = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
      return decoded.byteLength === lengths[algorithm] && decoded.toString('base64') === match[2]
        ? { algorithm, value: decoded.toString('hex') } : null;
    })
    .filter((item): item is { algorithm: typeof order[number]; value: string } => item !== null)
    .sort((a, b) => order.indexOf(a.algorithm) - order.indexOf(b.algorithm))[0];
  return found ?? null;
}

async function unique<T>(work: () => Promise<T>, onDuplicate: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if ((error as { code?: string }).code === '23505') return onDuplicate();
    throw error;
  }
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/**
 * Exact artifact locks over the caller's own npm registry resolution receipts
 * and their replays. A lock never changes; update is a new lock. Replay
 * re-fetches every locked locator from its fixed origin, verifies the locked
 * digest, retains verified bytes in the artifact store and reports each
 * artifact as verified, digest-mismatch, unavailable, revoked or unverifiable.
 */
export class PackageLockStore {
  constructor(private readonly pool: Pool, private readonly npm: Pick<NpmResolutionStore, 'read'>,
    readonly artifacts: PackageArtifactStore, private readonly options: { fetcher?: typeof fetch } = {}) {}

  async create(principalId: string, key: string, request: PackageLockRequest):
    Promise<{ lock: PackageLockView; replayed: boolean }> {
    if (!KEY.test(key)) throw new PackageLockInvalid('invalid idempotency key');
    if (request?.profile !== PACKAGE_LOCK_PROFILE || !Array.isArray(request.segments)
      || request.segments.length < 1 || request.segments.length > 16
      || new Set(request.segments.map(item => `${item.scope?.kind}:${item.scope?.label}`)).size
        !== request.segments.length) {
      throw new PackageLockInvalid('lock request is malformed');
    }
    const requestDigest = sha(stableJson(request));
    const existing = await this.row(principalId, key);
    if (existing) return this.replayed(existing, requestDigest);
    const id = randomUUID();
    const segments: PackageLockView['manifest']['segments'] = [];
    const artifacts: LockedArtifact[] = [];
    for (const [ordinal, segment] of request.segments.entries()) {
      if (segment.ecosystem !== 'npm' || !UUID.test(segment.resolution)) {
        throw new PackageLockInvalid('only npm registry resolution segments are admitted');
      }
      const resolution = await this.npm.read(principalId, segment.resolution);
      if (!resolution) throw new PackageLockUnavailable('resolution is unavailable');
      const outcome = resolution.outcome as NpmRegistryOutcome & { artifactVerification?: string };
      if (resolution.profile !== 'npm-registry-resolution-receipt-v1' || outcome.status !== 'solved'
        || outcome.artifactVerification !== 'verified') {
        throw new PackageLockInvalid('only a solved, artifact-verified resolution can be locked');
      }
      segments.push({ ordinal, ecosystem: 'npm', adapterProfile: resolution.profile, scope: segment.scope,
        resolution: segment.resolution, resolutionRequestDigest: resolution.requestDigest,
        environment: { target: (resolution.request as { target?: unknown }).target ?? null,
          engineTarget: (resolution.request as { engineTarget?: unknown }).engineTarget ?? null } });
      for (const instance of outcome.instances.filter(item => item.kind === 'registry' && item.active)
        .sort((a, b) => (a.path < b.path ? -1 : 1))) {
        const integrity = instance.integrity ? strongestIntegrity(instance.integrity) : null;
        if (!instance.resolved || !integrity || !npmRegistryTarballAllowed(instance.name, instance.resolved)) {
          throw new PackageLockInvalid('a locked instance lacks a fixed-origin tarball or SRI');
        }
        const tag = instance.selection?.reason === 'dist-tag'
          ? `dist-tag:${instance.selection.spec}` : null;
        artifacts.push({ ordinal: artifacts.length, segment: ordinal, ecosystem: 'npm',
          instanceKey: instance.path, locator: instance.resolved, mutableReference: tag,
          coordinate: { registry: 'https://registry.npmjs.org/', name: instance.name,
            version: instance.version, path: instance.path, hasInstallScript: instance.hasInstallScript },
          integrity: { basis: 'registry-digest', ...integrity } });
      }
    }
    if (artifacts.length > npmRegistryLimits.artifacts) throw new PackageLockInvalid('lock exceeds 256 artifacts');
    const manifest: PackageLockView['manifest'] = { contractVersion: PACKAGE_LOCK_PROFILE, lockId: id, request,
      segments, artifacts, provenance: { operation: 'package-lock-create-v1' } };
    const canonical = Buffer.from(stableJson(manifest), 'utf8');
    return unique(async () => transaction(this.pool, async client => {
      await client.query(`INSERT INTO pkg.lock (id, principal_id, idempotency_key, request_digest,
          contract_version, canonical_bytes, lock_sha256, manifest, segment_count, artifact_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, principalId, key, requestDigest, PACKAGE_LOCK_PROFILE, canonical, sha(canonical),
        canonical.toString('utf8'), segments.length, artifacts.length]);
      for (const segment of segments) {
        await client.query(`INSERT INTO pkg.lock_segment (lock_id, ordinal, principal_id, ecosystem,
            adapter_profile, scope_kind, scope_label, npm_resolution_id)
          VALUES ($1, $2, $3, 'npm', $4, $5, $6, $7)`, [id, segment.ordinal, principalId,
          segment.adapterProfile, segment.scope.kind, segment.scope.label, segment.resolution]);
      }
      for (const item of artifacts) {
        await client.query(`INSERT INTO pkg.lock_artifact (lock_id, ordinal, segment_ordinal, ecosystem,
            instance_key, coordinate, locator, mutable_reference, integrity_basis, digest_algorithm,
            digest_value) VALUES ($1, $2, $3, 'npm', $4, $5, $6, $7, 'registry-digest', $8, $9)`,
        [id, item.ordinal, item.segment, item.instanceKey, JSON.stringify(item.coordinate), item.locator,
          item.mutableReference, item.integrity.algorithm, item.integrity.value]);
      }
      return { lock: this.view((await client.query<LockRow>('SELECT * FROM pkg.lock WHERE id = $1',
        [id])).rows[0]!), replayed: false };
    }), async () => this.replayed((await this.row(principalId, key))!, requestDigest));
  }

  async read(principalId: string, id: string): Promise<PackageLockView | null> {
    if (!UUID.test(id)) return null;
    const row = (await this.pool.query<LockRow>('SELECT * FROM pkg.lock WHERE id = $1 AND principal_id = $2',
      [id, principalId])).rows[0];
    return row ? this.view(row) : null;
  }

  async replay(principalId: string, key: string, lockId: string):
    Promise<{ replay: LockReplayView; replayed: boolean }> {
    if (!KEY.test(key)) throw new PackageLockInvalid('invalid idempotency key');
    const requestDigest = sha(stableJson({ lock: lockId, policy: LOCK_REPLAY_POLICY }));
    const replayed = async () => {
      const existing = (await this.pool.query<LockReplayRow>(`SELECT * FROM pkg.lock_replay
        WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
      if (!existing) return null;
      if (existing.request_digest !== requestDigest) throw new PackageLockConflict('idempotency key belongs to another replay');
      return { replay: (await this.readReplay(principalId, existing.id))!, replayed: true };
    };
    const previous = await replayed();
    if (previous) return previous;
    const lock = await this.read(principalId, lockId);
    if (!lock) throw new PackageLockUnavailable('lock is unavailable');
    const rows = (await this.pool.query<LockArtifactRow>(`SELECT * FROM pkg.lock_artifact
      WHERE lock_id = $1 ORDER BY ordinal`, [lockId])).rows;
    let total = 0;
    const results: Array<Omit<LockReplayArtifactRow, 'replay_id' | 'lock_id'>> = [];
    for (const row of rows) {
      const base = { artifact_ordinal: row.ordinal, observed_sha256: null, observed_byte_length: null,
        artifact_id: null, artifact_sha256: null };
      const coordinate = row.coordinate as LockedArtifact['coordinate'];
      if (row.integrity_basis === 'unverifiable' || !row.digest_algorithm || row.digest_algorithm === 'go-h1') {
        results.push({ ...base, result: 'unverifiable' });
        continue;
      }
      const fetched = npmRegistryTarballAllowed(coordinate.name, row.locator)
        ? await this.fetchBounded(row.locator, npmRegistryLimits.totalArtifactBytes - total) : null;
      if (!fetched) { results.push({ ...base, result: 'unavailable' }); continue; }
      total += fetched.byteLength;
      const observed = sha(fetched);
      const locked = createHash(row.digest_algorithm).update(fetched).digest('hex');
      const measured = { ...base, observed_sha256: observed, observed_byte_length: String(fetched.byteLength) };
      if (locked !== row.digest_value) { results.push({ ...measured, result: 'digest-mismatch' }); continue; }
      if ((await this.artifacts.revoked([observed])).size) { results.push({ ...measured, result: 'revoked' }); continue; }
      const retained = await this.artifacts.retain(fetched, 'application/gzip', null);
      results.push({ ...measured, result: 'verified', artifact_id: retained.id, artifact_sha256: observed });
    }
    const id = randomUUID();
    const outcome = results.every(item => item.result === 'verified') ? 'verified' : 'unavailable';
    return unique(async () => {
      await transaction(this.pool, async client => {
        await client.query(`INSERT INTO pkg.lock_replay (id, principal_id, idempotency_key, request_digest,
            lock_id, lock_sha256, policy, outcome) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, principalId, key, requestDigest, lockId, lock.lockSha256, LOCK_REPLAY_POLICY, outcome]);
        for (const item of results) {
          await client.query(`INSERT INTO pkg.lock_replay_artifact (replay_id, lock_id, artifact_ordinal,
              result, observed_sha256, observed_byte_length, artifact_id, artifact_sha256)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, lockId, item.artifact_ordinal, item.result,
            item.observed_sha256, item.observed_byte_length, item.artifact_id, item.artifact_sha256]);
        }
      });
      return { replay: (await this.readReplay(principalId, id))!, replayed: false };
    }, async () => (await replayed())!);
  }

  async readReplay(principalId: string, id: string): Promise<LockReplayView | null> {
    if (!UUID.test(id)) return null;
    const replay = (await this.pool.query<LockReplayRow>(`SELECT * FROM pkg.lock_replay
      WHERE id = $1 AND principal_id = $2`, [id, principalId])).rows[0];
    if (!replay) return null;
    const items = (await this.pool.query<LockReplayArtifactRow & LockArtifactRow>(`SELECT r.*, a.instance_key,
        a.locator, a.mutable_reference FROM pkg.lock_replay_artifact r
      JOIN pkg.lock_artifact a ON a.lock_id = r.lock_id AND a.ordinal = r.artifact_ordinal
      WHERE r.replay_id = $1 ORDER BY r.artifact_ordinal`, [id])).rows;
    return { replay: replay.id, lock: replay.lock_id, lockSha256: replay.lock_sha256,
      policy: LOCK_REPLAY_POLICY, outcome: replay.outcome,
      artifacts: items.map(item => ({ ordinal: item.artifact_ordinal, instanceKey: item.instance_key,
        locator: item.locator, mutableReference: item.mutable_reference, result: item.result,
        observedSha256: item.observed_sha256,
        observedByteLength: item.observed_byte_length === null ? null : Number(item.observed_byte_length),
        artifact: item.artifact_id })),
      createdAt: replay.created_at.toISOString() };
  }

  /** The newest verified replay of a lock, which supplies retained bytes to installation plans. */
  async latestVerifiedReplay(principalId: string, lockId: string): Promise<LockReplayView | null> {
    const row = (await this.pool.query<{ id: string }>(`SELECT id FROM pkg.lock_replay
      WHERE lock_id = $1 AND principal_id = $2 AND outcome = 'verified'
      ORDER BY created_at DESC, id LIMIT 1`, [lockId, principalId])).rows[0];
    return row ? this.readReplay(principalId, row.id) : null;
  }

  private async row(principalId: string, key: string): Promise<LockRow | undefined> {
    return (await this.pool.query<LockRow>(`SELECT * FROM pkg.lock
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
  }

  private replayed(row: LockRow, requestDigest: string): { lock: PackageLockView; replayed: boolean } {
    if (row.request_digest !== requestDigest) throw new PackageLockConflict('idempotency key belongs to another lock');
    return { lock: this.view(row), replayed: true };
  }

  private view(row: LockRow): PackageLockView {
    if (sha(row.canonical_bytes) !== row.lock_sha256) throw new PackageLockUnavailable('lock bytes are corrupt');
    return { lock: row.id, contractVersion: PACKAGE_LOCK_PROFILE, lockSha256: row.lock_sha256,
      manifest: JSON.parse(row.canonical_bytes.toString('utf8')) as PackageLockView['manifest'],
      createdAt: row.created_at.toISOString() };
  }

  private async fetchBounded(url: string, remaining: number): Promise<Uint8Array | null> {
    const limit = Math.min(npmRegistryLimits.artifactBytes, remaining);
    try {
      const response = await (this.options.fetcher ?? fetch)(url, { redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status !== 200) { await response.body?.cancel(); return null; }
      if (Number(response.headers.get('content-length') ?? '0') > limit) { await response.body?.cancel(); return null; }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const next = reader ? await reader.read() : { done: true as const, value: undefined };
        if (next.done) break;
        length += next.value.byteLength;
        if (length > limit) { await reader!.cancel(); return null; }
        chunks.push(next.value);
      }
      return Buffer.concat(chunks);
    } catch { return null; }
  }
}
