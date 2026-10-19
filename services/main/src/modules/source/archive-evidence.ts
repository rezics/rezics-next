import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { RightsStore } from '../rights/store.ts';
import type { SourceIntakeStore, StagedSourceObservation } from './intake.ts';
import { readCurrentSourceObservation } from './cover-evidence.ts';
import { SOURCE_ARCHIVE_LIMITS, SourceArchiveConflict, SourceArchiveInvalid, SourceArchiveUnavailable,
  verifyVndbCopyRow, type SourceArchiveMediaType, type VerifiedVndbCopyRow, type VndbCopyCoordinate } from './archive-copy.ts';
export { SOURCE_ARCHIVE_LIMITS, SourceArchiveConflict, SourceArchiveInvalid, SourceArchiveUnavailable,
  verifyVndbCopyRow } from './archive-copy.ts';
export type { SourceImageRole, SourceArchiveMediaType, VndbCopyCoordinate, VerifiedVndbCopyRow } from './archive-copy.ts';

const ID = 'https://rezics.com/id/';
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface RetainedArchivePart { index: number; record: string; observation: string; byteDigest: string }
export interface RetainedArchiveInput {
  profile: 'source-retained-archive-v1';
  record: string; observation: string; observationDigest: string;
  archiveDigest: string; byteLength: number; mediaType: SourceArchiveMediaType;
  /** Raw binary parts, in original order. JSON URL/chunk envelopes are not bytes. */
  parts: RetainedArchivePart[];
}
export interface RetainedArchiveAdmission extends RetainedArchiveInput {
  admission: string;
  /** This persisted Source receipt is the admission identity, never a derived URL. */
  receipt: string;
}
export interface SourceArchiveImageWitness {
  profile: 'source-archive-image-witness-v1';
  archive: RetainedArchiveAdmission;
  source: { record: string; observation: string; observationDigest: string;
    provider: string; namespace: string; externalId: string; sourceRevision: string | null; captureUrl: string | null };
  row: VerifiedVndbCopyRow;
}
interface AdmissionRow {
  id: string; request_digest: string; record_id: string; observation_id: string; observation_digest: string;
  archive_digest: string; byte_length: string; media_type: SourceArchiveMediaType; parts: RetainedArchivePart[];
}
function admission(row: AdmissionRow): RetainedArchiveAdmission {
  return { profile: 'source-retained-archive-v1', admission: `${ID}${row.id}`, receipt: `${ID}${row.id}`,
    record: `${ID}${row.record_id}`, observation: `${ID}${row.observation_id}`, observationDigest: row.observation_digest,
    archiveDigest: row.archive_digest, byteLength: Number(row.byte_length), mediaType: row.media_type, parts: row.parts };
}
function validate(input: RetainedArchiveInput): void {
  if (input.profile !== 'source-retained-archive-v1' || !NATIVE.test(input.record) || !NATIVE.test(input.observation)
    || !SHA.test(input.observationDigest) || !SHA.test(input.archiveDigest)
    || !Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > SOURCE_ARCHIVE_LIMITS.bytes
    || !['application/x-tar', 'application/zstd'].includes(input.mediaType)
    || !Array.isArray(input.parts) || !input.parts.length || input.parts.length > SOURCE_ARCHIVE_LIMITS.parts
    || new Set(input.parts.map(part => part.observation)).size !== input.parts.length
    || input.parts.some((part, index) => part.index !== index || !NATIVE.test(part.record)
      || !NATIVE.test(part.observation) || !SHA.test(part.byteDigest))
    || input.parts[0]!.record !== input.record || input.parts[0]!.observation !== input.observation
    || input.parts[0]!.byteDigest !== input.observationDigest) throw new SourceArchiveInvalid('invalid retained archive receipt manifest');
}

/** Custody is populated solely from actual principal-scoped Source receipts.
 * Objects use an observation-specific namespace, so byte reuse grants no read. */
export class SourceArchiveEvidenceOwner {
  constructor(private readonly pool: Pool,
    private readonly intake: Pick<SourceIntakeStore, 'read'>,
    private readonly access: Pick<AccessAdmissionRegistry, 'activePrincipalId' | 'hasNonBaselineWorkCreateAuthority'>,
    private readonly rights: Pick<RightsStore, 'rawRetentionPermitted'>,
    private readonly objects: (namespace: string) => ImmutableObjects) {}

  private namespace(principalId: string, observation: string): string {
    return `source/archive/${principalId}/${observation.slice(ID.length)}/`;
  }
  private async observations(principalId: string, input: RetainedArchiveInput): Promise<StagedSourceObservation[]> {
    const parts: StagedSourceObservation[] = [];
    for (const part of input.parts) {
      const observation = await readCurrentSourceObservation(this.pool, this.intake, principalId, part.observation);
      if (!observation || observation.record !== part.record || observation.byteDigest !== part.byteDigest
        || observation.retention !== 'retained' || !observation.rawBytesBase64
        || observation.byteLength === null || observation.byteLength > 262_144
        || !['application/octet-stream', input.mediaType].includes(observation.mediaType)) {
        throw new SourceArchiveUnavailable('original retained archive part is unavailable');
      }
      if (parts[0] && (observation.provider !== parts[0].provider || observation.namespace !== parts[0].namespace
        || observation.externalId !== parts[0].externalId || observation.sourceRevision !== parts[0].sourceRevision)) {
        throw new SourceArchiveConflict('archive part source identity differs');
      }
      parts.push(observation);
    }
    const first = parts[0]!;
    if (!await this.rights.rawRetentionPermitted(first.provider, first.namespace)) {
      throw new SourceArchiveUnavailable('archive retention is unavailable under current provider terms');
    }
    return parts;
  }

  async admit(principal: VerifiedPrincipal, actingSubject: string, key: string, input: RetainedArchiveInput):
    Promise<{ admission: RetainedArchiveAdmission; replayed: boolean }> {
    validate(input);
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key) || !NATIVE.test(actingSubject)) throw new SourceArchiveInvalid('invalid archive admission identity');
    const principalId = await this.access.activePrincipalId(principal);
    if (!principalId || !await this.access.hasNonBaselineWorkCreateAuthority(principal, actingSubject)) {
      throw new SourceArchiveUnavailable('Source import authority is unavailable');
    }
    const intent = JSON.stringify({ actingSubject, profile: input.profile, record: input.record,
      observation: input.observation, observationDigest: input.observationDigest, archiveDigest: input.archiveDigest,
      byteLength: input.byteLength, mediaType: input.mediaType,
      parts: input.parts.map(part => ({ index: part.index, record: part.record, observation: part.observation, byteDigest: part.byteDigest })) });
    const digest = hash(intent);
    const parts = await this.observations(principalId, input);
    const existing = (await this.pool.query<AdmissionRow>(
      'SELECT * FROM source.archive_admission WHERE principal_id=$1 AND idempotency_key=$2', [principalId, key])).rows[0];
    if (existing && existing.request_digest !== digest) throw new SourceArchiveConflict('archive admission key changed intent');
    const objects = this.objects(this.namespace(principalId, input.observation));
    if (existing) {
      const bytes = await this.readBytes(objects, input.archiveDigest, input.byteLength);
      if (bytes.length !== input.byteLength || hash(bytes) !== input.archiveDigest) throw new SourceArchiveUnavailable('archive custody digest differs');
      await this.observations(principalId, input);
      if (await this.access.activePrincipalId(principal) !== principalId
        || !await this.access.hasNonBaselineWorkCreateAuthority(principal, actingSubject)) {
        throw new SourceArchiveUnavailable('Source import authority changed');
      }
      return { admission: admission(existing), replayed: true };
    }
    const buffers = parts.map(part => {
      const bytes = Buffer.from(part.rawBytesBase64!, 'base64');
      if (bytes.toString('base64') !== part.rawBytesBase64 || bytes.length !== part.byteLength || hash(bytes) !== part.byteDigest) {
        throw new SourceArchiveUnavailable('retained archive part digest differs');
      }
      return bytes;
    });
    if (buffers.reduce((sum, bytes) => sum + bytes.length, 0) !== input.byteLength) throw new SourceArchiveConflict('archive byte length differs');
    const bytes = Buffer.concat(buffers);
    if (hash(bytes) !== input.archiveDigest) throw new SourceArchiveConflict('original archive digest differs');
    let stored: string;
    try { stored = await objects.put(bytes); }
    catch (cause) { throw new SourceArchiveUnavailable('archive custody write is unavailable', { cause }); }
    if (stored !== input.archiveDigest) throw new SourceArchiveUnavailable('archive custody digest differs');
    const retained = await this.readBytes(objects, input.archiveDigest, input.byteLength);
    if (retained.length !== input.byteLength || hash(retained) !== input.archiveDigest) throw new SourceArchiveUnavailable('archive custody read-back differs');
    // Repeat live owner checks after the object write. This is verified before
    // commit, not a cross-owner transaction guarantee.
    await this.observations(principalId, input);
    if (await this.access.activePrincipalId(principal) !== principalId
      || !await this.access.hasNonBaselineWorkCreateAuthority(principal, actingSubject)) throw new SourceArchiveUnavailable('Source import authority changed');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`source-archive:${principalId}:${key}`]);
      const prior = (await client.query<AdmissionRow>('SELECT * FROM source.archive_admission WHERE principal_id=$1 AND idempotency_key=$2', [principalId, key])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new SourceArchiveConflict('archive admission key changed intent');
        await client.query('COMMIT'); return { admission: admission(prior), replayed: true };
      }
      const row = (await client.query<AdmissionRow>(`INSERT INTO source.archive_admission
        (id,principal_id,idempotency_key,request_digest,record_id,observation_id,observation_digest,
          archive_digest,byte_length,media_type,parts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
      [randomUUID(), principalId, key, digest, input.record.slice(ID.length), input.observation.slice(ID.length),
        input.observationDigest, input.archiveDigest, input.byteLength, input.mediaType, JSON.stringify(input.parts)])).rows[0]!;
      await client.query('COMMIT'); return { admission: admission(row), replayed: false };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async readBytes(objects: ImmutableObjects, digest: string, byteLength: number): Promise<Uint8Array> {
    try { return await objects.get(digest, byteLength); }
    catch (cause) { throw new SourceArchiveUnavailable('retained archive object is unavailable', { cause }); }
  }

  async verify(principal: VerifiedPrincipal, admissionId: string, coordinate: VndbCopyCoordinate):
    Promise<SourceArchiveImageWitness> {
    if (!NATIVE.test(admissionId)) throw new SourceArchiveInvalid('invalid archive admission');
    const principalId = await this.access.activePrincipalId(principal);
    if (!principalId) throw new SourceArchiveUnavailable('archive evidence is unavailable');
    const row = (await this.pool.query<AdmissionRow>(
      'SELECT * FROM source.archive_admission WHERE id=$1 AND principal_id=$2', [admissionId.slice(ID.length), principalId])).rows[0];
    if (!row) throw new SourceArchiveUnavailable('archive evidence is unavailable');
    const manifest = admission(row); validate(manifest);
    const parts = await this.observations(principalId, manifest);
    const first = parts[0]!;
    if (first.provider !== 'vndb') throw new SourceArchiveInvalid('COPY image verification requires the retained VNDB source');
    const bytes = await this.readBytes(this.objects(this.namespace(principalId, manifest.observation)), manifest.archiveDigest, manifest.byteLength);
    if (bytes.length !== manifest.byteLength || hash(bytes) !== manifest.archiveDigest) throw new SourceArchiveUnavailable('original archive custody is unavailable');
    const verified = await verifyVndbCopyRow(bytes, manifest.mediaType, coordinate);
    await this.observations(principalId, manifest);
    if (await this.access.activePrincipalId(principal) !== principalId) throw new SourceArchiveUnavailable('archive principal changed');
    return { profile: 'source-archive-image-witness-v1', archive: manifest,
      source: { record: first.record, observation: first.observation, observationDigest: first.byteDigest!,
        provider: first.provider, namespace: first.namespace, externalId: first.externalId,
        sourceRevision: first.sourceRevision, captureUrl: first.capture?.url ?? null }, row: verified };
  }
}
