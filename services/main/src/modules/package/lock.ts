import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { npmRegistryLimits, npmRegistryTarballAllowed, type NpmRegistryOutcome }
  from './npm-registry.ts';
import type { NpmResolutionStore } from './npm-resolution.ts';
import type { CargoResolutionStore, CargoResolution } from './cargo-resolution.ts';
import type { GoMvsResolutionStore, GoMvsResolution, GoModuleRequirement }
  from './go-mvs.ts';
import type { GoSumdbTrustStore } from './go-sumdb-trust.ts';
import type { GoProxyCaptureStore } from './go-proxy-capture.ts';
import { PackageArtifactStore } from './lock-artifacts.ts';
import { goModuleZipH1 } from './lock-go-zip.ts';
import { stableJson, type LockArtifactRow, type LockReplayArtifactRow, type LockReplayRow,
  type LockRow } from './lock-schema.ts';

export class PackageLockInvalid extends Error {}
export class PackageLockConflict extends Error {}
export class PackageLockUnavailable extends Error {}

export const PACKAGE_LOCK_PROFILE = 'rezics-package-lock-v1';
export const LOCK_REPLAY_POLICY = 'exact-artifact-replay-v1';

export interface PackageLockRequest {
  profile: typeof PACKAGE_LOCK_PROFILE;
  segments: Array<{ ecosystem: 'npm' | 'cargo' | 'go'; resolution: string;
    scope: { kind: 'process' | 'path' | 'abi'; label: string } }>;
}

export interface LockedArtifact {
  ordinal: number; segment: number; ecosystem: 'npm' | 'cargo' | 'go'; instanceKey: string;
  coordinate: Record<string, unknown>;
  locator: string; mutableReference: string | null;
  integrity: { basis: 'registry-digest'; algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512' | 'go-h1';
    value: string };
}

export interface PackageLockView {
  lock: string; contractVersion: typeof PACKAGE_LOCK_PROFILE; lockSha256: string;
  manifest: { contractVersion: string; lockId: string; request: PackageLockRequest;
    segments: Array<{ ordinal: number; ecosystem: 'npm' | 'cargo' | 'go'; adapterProfile: string;
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
const CARGO_INDEX = 'https://index.crates.io/';
const GO_PROXY = 'https://proxy.golang.org/';
const SHA256 = /^[0-9a-f]{64}$/;
const GO_H1 = /^h1:[A-Za-z0-9+/]{43}=$/;

function cargoChecksums(resolution: CargoResolution): Map<string, string> {
  const checksums = new Map<string, string>();
  try {
    for (const file of resolution.request.indexFiles) {
      for (const line of Buffer.from(file.bytesBase64, 'base64').toString('utf8').trimEnd().split('\n')) {
        const item = JSON.parse(line) as { name?: unknown; vers?: unknown; cksum?: unknown };
        if (item.name !== file.name || typeof item.vers !== 'string'
          || typeof item.cksum !== 'string' || !SHA256.test(item.cksum)) {
          throw new Error('index entry differs');
        }
        const key = `${item.name}@${item.vers}`;
        if (checksums.has(key)) throw new Error('duplicate index entry');
        checksums.set(key, item.cksum);
      }
    }
  } catch { throw new PackageLockInvalid('retained Cargo index is unreadable'); }
  return checksums;
}

function cargoLocator(name: string, version: string): string {
  return `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
}

function goLocator(source: GoModuleRequirement): string {
  return `${GO_PROXY}${source.path}/@v/${source.version}.zip`;
}

function sourceOf(resolution: GoMvsResolution, selected: GoModuleRequirement):
  { source: GoModuleRequirement; captureId: string } {
  const selectedEvidence = resolution.outcome.selectedSourceEvidence?.find(item =>
    item.original.path === selected.path && item.original.version === selected.version);
  if (selectedEvidence && !selectedEvidence.capture) {
    throw new PackageLockInvalid('selected Go module has no retained proxy capture');
  }
  const source = selectedEvidence?.source ?? selected;
  const capture = selectedEvidence?.capture ?? resolution.request.captureEvidence?.find(item =>
    item.path === source.path && item.version === source.version);
  if (!capture?.captureId) throw new PackageLockInvalid('selected Go module lacks capture evidence');
  return { source, captureId: capture.captureId };
}

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
    readonly artifacts: PackageArtifactStore, private readonly options: { fetcher?: typeof fetch;
      cargo?: Pick<CargoResolutionStore, 'read'>; go?: Pick<GoMvsResolutionStore, 'read'>;
      sumdb?: Pick<GoSumdbTrustStore, 'read'>;
      captures?: Pick<GoProxyCaptureStore, 'read'> } = {}) {}

  /** Composition roots attach the non-npm owners after constructing the shared lock store. */
  registerResolutionOwners(owners: { cargo: Pick<CargoResolutionStore, 'read'>;
    go: Pick<GoMvsResolutionStore, 'read'>; sumdb: Pick<GoSumdbTrustStore, 'read'>;
    captures: Pick<GoProxyCaptureStore, 'read'> }): void {
    Object.assign(this.options, owners);
  }

  private async validateGoCaptures(principalId: string, resolution: GoMvsResolution): Promise<void> {
    const evidence = resolution.request.captureEvidence;
    if (!evidence || !this.options.captures || evidence.length !== resolution.request.releases.length) {
      throw new PackageLockInvalid('Go solution lacks a complete retained capture set');
    }
    const releases = new Map(resolution.request.releases.map(item => [`${item.path}@${item.version}`, item]));
    if (releases.size !== evidence.length) throw new PackageLockInvalid('Go capture identities are duplicated');
    for (const item of evidence) {
      const capture = await this.options.captures.read(principalId, item.captureId);
      const release = releases.get(`${item.path}@${item.version}`);
      if (!capture || !release || capture.path !== item.path || capture.version !== item.version
        || capture.manifest.rawSha256 !== item.modSha256
        || capture.info.rawSha256 !== item.infoSha256
        || (item.listSha256 !== undefined && capture.versionList?.rawSha256 !== item.listSha256)
        || stableJson(capture.manifest.parsed.requirements) !== stableJson(release.requirements)
        || (release.goDirective !== undefined
          && release.goDirective !== capture.manifest.parsed.goDirective)) {
        throw new PackageLockInvalid('Go resolution differs from its retained proxy capture');
      }
    }
  }

  private async goChecksum(principalId: string, captureId: string,
    source: GoModuleRequirement): Promise<string> {
    if (!this.options.sumdb) throw new PackageLockUnavailable('Go checksum owner is unavailable');
    const row = (await this.pool.query<{ id: string; evidence: { recordTextBase64?: string } }>(
      `SELECT id, evidence FROM pkg.go_sumdb_verification WHERE principal_id = $1
        AND capture_id = $2 ORDER BY created_at DESC, id LIMIT 1`, [principalId, captureId])).rows[0];
    if (!row || !await this.options.sumdb.read(principalId, row.id)) {
      throw new PackageLockInvalid('selected Go module lacks a verified checksum receipt');
    }
    const record = Buffer.from(row.evidence.recordTextBase64 ?? '', 'base64').toString('utf8');
    const prefix = `${source.path} ${source.version} `;
    const values = record.split('\n').filter(line => line.startsWith(prefix)
      && !line.startsWith(`${source.path} ${source.version}/go.mod `)).map(line => line.slice(prefix.length));
    if (values.length !== 1 || !GO_H1.test(values[0]!)) {
      throw new PackageLockInvalid('verified Go record lacks the module ZIP hash');
    }
    return values[0]!;
  }

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
      if (!['npm', 'cargo', 'go'].includes(segment.ecosystem) || !UUID.test(segment.resolution)) {
        throw new PackageLockInvalid('invalid ecosystem resolution segment');
      }
      if (segment.ecosystem === 'cargo') {
        if (!this.options.cargo) throw new PackageLockUnavailable('Cargo resolution owner is unavailable');
        const resolution = await this.options.cargo.read(principalId, segment.resolution);
        if (!resolution) throw new PackageLockUnavailable('Cargo resolution is unavailable');
        if (resolution.outcome.status !== 'solved' || resolution.request.registryIndexUrl !== CARGO_INDEX) {
          throw new PackageLockInvalid('only a solved crates.io snapshot can be locked');
        }
        segments.push({ ordinal, ecosystem: 'cargo', adapterProfile: resolution.profile,
          scope: segment.scope, resolution: segment.resolution,
          resolutionRequestDigest: resolution.requestDigest,
          environment: { host: resolution.request.host, target: resolution.request.target } });
        const checksums = cargoChecksums(resolution);
        for (const selected of resolution.outcome.selected.filter(item => item.source !== 'root')
          .sort((a, b) => a.id.localeCompare(b.id))) {
          const checksum = checksums.get(`${selected.name}@${selected.version}`);
          if (!checksum) throw new PackageLockInvalid('selected Cargo crate lacks an exact archive checksum');
          artifacts.push({ ordinal: artifacts.length, segment: ordinal, ecosystem: 'cargo',
            instanceKey: selected.id, coordinate: { registry: CARGO_INDEX,
              name: selected.name, version: selected.version },
            locator: cargoLocator(selected.name, selected.version), mutableReference: null,
            integrity: { basis: 'registry-digest', algorithm: 'sha256', value: checksum } });
        }
        continue;
      }
      if (segment.ecosystem === 'go') {
        if (!this.options.go) throw new PackageLockUnavailable('Go resolution owner is unavailable');
        const resolution = await this.options.go.read(principalId, segment.resolution);
        if (!resolution) throw new PackageLockUnavailable('Go resolution is unavailable');
        if (resolution.outcome.status !== 'solved' || !resolution.request.captureEvidence) {
          throw new PackageLockInvalid('only a solved captured Go graph can be locked');
        }
        await this.validateGoCaptures(principalId, resolution);
        segments.push({ ordinal, ecosystem: 'go', adapterProfile: resolution.profile,
          scope: segment.scope, resolution: segment.resolution,
          resolutionRequestDigest: resolution.requestDigest,
          environment: { goDirective: resolution.request.goDirective,
            mainModule: resolution.request.mainModule } });
        for (const selected of resolution.outcome.buildList) {
          const { source, captureId } = sourceOf(resolution, selected);
          const checksum = await this.goChecksum(principalId, captureId, source);
          artifacts.push({ ordinal: artifacts.length, segment: ordinal, ecosystem: 'go',
            instanceKey: `${selected.path}@${selected.version}`,
            coordinate: { path: selected.path, version: selected.version,
              sourcePath: source.path, sourceVersion: source.version, capture: captureId },
            locator: goLocator(source), mutableReference: null,
            integrity: { basis: 'registry-digest', algorithm: 'go-h1', value: checksum } });
        }
        continue;
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
            adapter_profile, scope_kind, scope_label, go_resolution_id, cargo_resolution_id,
            npm_resolution_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [id, segment.ordinal, principalId,
          segment.ecosystem, segment.adapterProfile, segment.scope.kind, segment.scope.label,
          segment.ecosystem === 'go' ? segment.resolution : null,
          segment.ecosystem === 'cargo' ? segment.resolution : null,
          segment.ecosystem === 'npm' ? segment.resolution : null]);
      }
      for (const item of artifacts) {
        await client.query(`INSERT INTO pkg.lock_artifact (lock_id, ordinal, segment_ordinal, ecosystem,
            instance_key, coordinate, locator, mutable_reference, integrity_basis, digest_algorithm,
            digest_value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'registry-digest', $9, $10)`,
        [id, item.ordinal, item.segment, item.ecosystem, item.instanceKey,
          JSON.stringify(item.coordinate), item.locator,
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
      if (row.integrity_basis === 'unverifiable' || !row.digest_algorithm) {
        results.push({ ...base, result: 'unverifiable' });
        continue;
      }
      const allowed = row.ecosystem === 'npm'
        ? npmRegistryTarballAllowed(String(coordinate.name), row.locator)
        : row.ecosystem === 'cargo'
          ? row.locator === cargoLocator(String(coordinate.name), String(coordinate.version))
            && coordinate.registry === CARGO_INDEX
          : row.ecosystem === 'go'
            ? row.locator === goLocator({ path: String(coordinate.sourcePath),
              version: String(coordinate.sourceVersion) }) : false;
      const fetched = allowed ? await this.fetchBounded(row.locator,
        npmRegistryLimits.totalArtifactBytes - total) : null;
      if (!fetched) { results.push({ ...base, result: 'unavailable' }); continue; }
      total += fetched.byteLength;
      const observed = sha(fetched);
      let locked: string;
      try { locked = row.digest_algorithm === 'go-h1'
        ? goModuleZipH1(fetched, String(coordinate.sourcePath), String(coordinate.sourceVersion))
        : createHash(row.digest_algorithm).update(fetched).digest('hex'); }
      catch { locked = ''; }
      const measured = { ...base, observed_sha256: observed, observed_byte_length: String(fetched.byteLength) };
      if (locked !== row.digest_value) { results.push({ ...measured, result: 'digest-mismatch' }); continue; }
      if ((await this.artifacts.revoked([observed])).size) { results.push({ ...measured, result: 'revoked' }); continue; }
      const retained = await this.artifacts.retain(fetched, row.ecosystem === 'go'
        ? 'application/zip' : row.ecosystem === 'cargo' ? 'application/gzip' : 'application/gzip', null);
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
