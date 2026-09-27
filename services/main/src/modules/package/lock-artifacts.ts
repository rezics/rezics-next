import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { artifactObjectKey, stableJson, type ArtifactRow, type ArtifactRevocationRow } from './lock-schema.ts';

export class PackageArtifactUnavailable extends Error {}
export class PackageArtifactConflict extends Error {}
export class PackageArtifactInvalid extends Error {}

/** One immutable object namespace per retention domain, e.g. Main's S3ImmutableObjects. */
export type ArtifactNamespaces = (prefix: string) => ImmutableObjects;

export interface RetainedArtifact { id: string; sha256: string; byteLength: number; objectKey: string }

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function prefix(owner: string | null): string {
  return artifactObjectKey('0'.repeat(64), owner).slice(0, -'sha256/'.length - 64);
}

/**
 * RustFS-backed artifact bytes with PostgreSQL references. Bytes are staged and
 * read back through the immutable-object adapter before a verified row exists,
 * so a reference never claims integrity for bytes the store does not hold.
 */
export class PackageArtifactStore {
  constructor(private readonly pool: Pool, private readonly namespaces: ArtifactNamespaces) {}

  async retain(bytes: Uint8Array, mediaType: string, owner: string | null,
    db: Pool | PoolClient = this.pool): Promise<RetainedArtifact> {
    const digest = sha256(bytes);
    if (await this.namespaces(prefix(owner)).put(bytes) !== digest) {
      throw new PackageArtifactUnavailable('artifact digest differs after upload');
    }
    const objectKey = artifactObjectKey(digest, owner);
    await db.query(`INSERT INTO pkg.artifact (id, retention_domain, owner_principal_id, sha256,
        byte_length, media_type, object_key, state, settled_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'verified', clock_timestamp())
      ON CONFLICT DO NOTHING`,
    [randomUUID(), owner ? 'principal-private' : 'public-origin', owner, digest, bytes.byteLength,
      mediaType, objectKey]);
    const row = (await db.query<ArtifactRow>(`SELECT * FROM pkg.artifact
      WHERE object_key = $1`, [objectKey])).rows[0];
    if (!row || row.state !== 'verified') throw new PackageArtifactUnavailable('artifact is not retainable');
    return { id: row.id, sha256: digest, byteLength: bytes.byteLength, objectKey };
  }

  /** Exact bytes of a verified artifact; erased or missing bytes are unavailable. */
  async read(id: string): Promise<{ row: ArtifactRow; bytes: Uint8Array }> {
    const row = (await this.pool.query<ArtifactRow>('SELECT * FROM pkg.artifact WHERE id = $1', [id])).rows[0];
    if (!row || row.state !== 'verified') throw new PackageArtifactUnavailable('artifact is unavailable');
    try {
      return { row, bytes: await this.namespaces(prefix(row.owner_principal_id)).get(row.sha256) };
    } catch { throw new PackageArtifactUnavailable('artifact bytes are unavailable'); }
  }

  async revoked(digests: readonly string[], db: Pool | PoolClient = this.pool): Promise<Set<string>> {
    if (!digests.length) return new Set();
    return new Set((await db.query<{ sha256: string }>(`SELECT DISTINCT sha256
      FROM pkg.artifact_revocation WHERE sha256 = ANY($1::text[])`, [[...digests]])).rows
      .map(row => row.sha256));
  }

  /** Append-only revocation of exact bytes in every retention domain. */
  async revoke(principalId: string, key: string, input: { sha256: string;
    reason: ArtifactRevocationRow['reason']; basis: Record<string, unknown> }):
    Promise<{ revocation: ArtifactRevocationView; replayed: boolean }> {
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new PackageArtifactInvalid('invalid artifact digest');
    const inserted = await this.pool.query<ArtifactRevocationRow>(`INSERT INTO pkg.artifact_revocation
        (id, principal_id, idempotency_key, sha256, reason, basis) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (principal_id, idempotency_key) DO NOTHING RETURNING *`,
    [randomUUID(), principalId, key, input.sha256, input.reason, JSON.stringify(input.basis)]);
    const row = inserted.rows[0] ?? (await this.pool.query<ArtifactRevocationRow>(`SELECT *
      FROM pkg.artifact_revocation WHERE principal_id = $1 AND idempotency_key = $2`,
    [principalId, key])).rows[0]!;
    if (row.sha256 !== input.sha256 || row.reason !== input.reason
      || stableJson(row.basis) !== stableJson(input.basis)) {
      throw new PackageArtifactConflict('idempotency key belongs to another revocation');
    }
    return { revocation: { revocation: row.id, sha256: row.sha256, reason: row.reason,
      basis: row.basis, createdAt: row.created_at.toISOString() }, replayed: !inserted.rows[0] };
  }
}

export interface ArtifactRevocationView {
  revocation: string; sha256: string; reason: string; basis: Record<string, unknown>; createdAt: string;
}
