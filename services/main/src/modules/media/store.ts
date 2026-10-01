import { withPreservationFence, type PreservationFence } from '../public-report/preservation.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ContentCore, ContentPosition } from '../../../../content/src/core.ts';

/** Media commands in Main's Content database. Every command writes one
 * `content.receipt`, its `content.outbox` event and its media rows together. */
export class MediaInvalid extends Error {}
export class MediaConflict extends Error {}
export class MediaStale extends Error {}
export class MediaMissing extends Error {}
export class MediaUnavailable extends Error {}
export class MediaCopyRestorationUnavailable extends MediaUnavailable {}
export class MediaFenced extends Error {}

export const DEFAULT_MEDIA_CONTEXT = 'urn:rezics:media:context:default';
export const AVATAR_POLICY = 'avatar-selection-v1';
const RECIPE = 'media-v1';
const ID = 'https://rezics.com/id/';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const sha = /^[0-9a-f]{64}$/;
const crop = /^xywh=percent:([0-9]{1,3}(\.[0-9]{1,3})?,){3}[0-9]{1,3}(\.[0-9]{1,3})?$/;
export const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type MediaType = typeof MEDIA_TYPES[number];
export type Clearance = 'screening' | 'cleared' | 'held' | 'rejected';
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Bounded avatar rendition: an original inside these limits is served as-is. */
export const AVATAR_LIMITS = { maxPixels: 2048, maxBytes: 4 * 1024 * 1024 } as const;
const MAX_SUMMARY_TARGETS = 64;

export interface MediaAdmission {
  admissionId: string;
  principalId: string;
  actingSubject: string;
  authorityEpoch: string;
  requestDigest: string;
}

export interface ReserveUploadInput {
  asset: string | null;
  mediaType: MediaType;
  byteLength: number;
  sha256: string;
  disclosure: 'private' | 'public';
}

export interface UploadReservation {
  asset: string;
  upload: string;
  quarantineKey: string;
  objectNamespace: string;
  expiresAt: string;
  stateHead: string;
  position: ContentPosition;
  replayed: boolean;
}

export interface UploadRow {
  id: string;
  asset: string;
  status: 'reserved' | 'activated' | 'rejected' | 'expired';
  mediaType: MediaType;
  byteLength: number;
  sha256: string | null;
  quarantineKey: string;
  objectNamespace: string;
  owner: string;
  expired: boolean;
  representation: string | null;
  principal: string;
  reason: string | null;
  clearance: Clearance | null;
  clearanceReason: string | null;
}

export interface ActivatedUpload {
  asset: string;
  upload: string;
  representation: string;
  sha256: string;
  status: 'activated' | 'rejected';
  reason: string | null;
  position: ContentPosition;
  replayed: boolean;
}

export interface AssetStateChangeInput {
  asset: string;
  expectedState: string;
  disclosure: 'private' | 'public';
  lifecycle: 'active' | 'deleted' | 'erased';
}

export interface AvatarSelectionInput {
  target: string;
  context: string;
  expectedSelection: string | null;
  /** NULL records an explicit removal; the summary then resolves the fallback. */
  asset: string | null;
  crop: string | null;
}

export interface PublicationItemBasis {
  asset: string;
  revision: string;
  representation: string;
  sha256: string;
  mediaType: string;
  width: number;
  height: number;
}

export interface CommandOutcome {
  outcome: 'succeeded' | 'stale_head' | 'rejected';
  id: string | null;
  predecessor: string | null;
  position: ContentPosition;
  replayed: boolean;
}

export interface AvatarRow {
  target: string;
  context: string | null;
  selection: string | null;
  selectionPosition: string | null;
  use: string | null;
  asset: string | null;
  crop: string | null;
  representation: string | null;
  sha256: string | null;
  mediaType: string | null;
  byteLength: number | null;
  width: number | null;
  height: number | null;
  availability: string | null;
  clearance: Clearance | null;
  disclosure: string | null;
  moderation: string | null;
  lifecycle: string | null;
  statePosition: string | null;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function position(row: { data_epoch: string; sequence: string }): ContentPosition {
  return { owner: 'content', dataEpoch: row.data_epoch, sequence: String(row.sequence) };
}

function checkAdmission(admission: MediaAdmission): void {
  if (!uuid.test(admission.admissionId) || !uuid.test(admission.principalId)
    || !nativeId.test(admission.actingSubject)
    || !/^(0|[1-9][0-9]{0,19})$/.test(admission.authorityEpoch) || !sha.test(admission.requestDigest)) {
    throw new MediaInvalid('media admission proof is invalid');
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
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** Lock the operation, then return its prior receipt if one exists. */
async function prior(client: PoolClient, operationId: string, digest: string, action: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operationId]);
  const result = await client.query<{ request_digest: string; action: string; outcome: string;
    reason: string | null; data_epoch: string; sequence: string }>(
    `SELECT request_digest, action, outcome, reason, data_epoch, sequence::text AS sequence
     FROM content.receipt WHERE operation_id = $1`, [operationId]);
  const row = result.rows[0];
  if (row && (row.request_digest !== digest || row.action !== action)) {
    throw new MediaConflict('media operation key binds another intent');
  }
  return row ?? null;
}

async function receipt(client: PoolClient, args: { operationId: string; digest: string;
  action: string; outcome: 'succeeded' | 'stale_head' | 'rejected'; reason?: string;
  eventType: string; payload: Record<string, unknown> }): Promise<ContentPosition> {
  const owner = await client.query<{ data_epoch: string; sequence: string }>(
    `UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton
     RETURNING data_epoch, sequence::text AS sequence`);
  if (owner.rowCount !== 1) throw new MediaUnavailable('Content owner position unavailable');
  const at = owner.rows[0]!;
  await client.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome,
    reason, data_epoch, sequence) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [args.operationId, args.digest, args.action, args.outcome, args.reason ?? null, at.data_epoch, at.sequence]);
  await client.query(`INSERT INTO content.outbox (id, data_epoch, sequence, operation_id, event_type,
    recipe, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
  [randomUUID(), at.data_epoch, at.sequence, args.operationId, args.eventType, RECIPE,
    JSON.stringify(args.payload)]);
  return position(at);
}

export function assetIri(asset: string): string { return `${ID}${asset}`; }
export function assetVariant(asset: string): string { return `urn:rezics:variant:${asset}`; }
export function assetNamespace(asset: string): string { return `media/asset/${asset}/`; }

/** One manifest per asset revision. Its exact bytes are the Content revision body. */
export function assetManifest(asset: string, representation: { id: string; sha256: string;
  byteLength: number; mediaType: string; width: number; height: number }): string {
  return JSON.stringify({ profile: 'media-asset-v1', asset: assetIri(asset), mediaKind: 'image',
    representations: [{ id: representation.id, role: 'original', sha256: representation.sha256,
      byteLength: representation.byteLength, mediaType: representation.mediaType,
      width: representation.width, height: representation.height }] });
}

export class MediaStore {
  constructor(private readonly pool: Pool, private readonly content: ContentCore) {}

  /** Create the asset when absent, then reserve one bounded quarantine upload. */
  async reserveUpload(admission: MediaAdmission, input: ReserveUploadInput): Promise<UploadReservation> {
    checkAdmission(admission);
    if ((input.asset !== null && !uuid.test(input.asset)) || !MEDIA_TYPES.includes(input.mediaType)
      || !Number.isSafeInteger(input.byteLength) || input.byteLength < 1
      || input.byteLength > MAX_UPLOAD_BYTES || !sha.test(input.sha256)
      || !['private', 'public'].includes(input.disclosure)) {
      throw new MediaInvalid('upload reservation is invalid');
    }
    const operationId = `media-upload:${admission.admissionId}`;
    return transaction(this.pool, async client => {
      const previous = await prior(client, operationId, admission.requestDigest, 'media.upload.reserve');
      if (previous) {
        if (previous.outcome !== 'succeeded') throw new MediaFenced('media upload admission was fenced');
        const row = await client.query<{ id: string; asset_id: string; expires_at: Date;
          state_head: string }>(`SELECT u.id, u.asset_id, u.expires_at, a.state_head FROM media.upload u
          JOIN media.asset a ON a.id = u.asset_id WHERE u.operation_id = $1`, [operationId]);
        const upload = row.rows[0]!;
        return { asset: upload.asset_id, upload: upload.id,
          quarantineKey: `media-quarantine/${upload.id}`, objectNamespace: assetNamespace(upload.asset_id),
          expiresAt: upload.expires_at.toISOString(), stateHead: upload.state_head,
          position: position(previous), replayed: true };
      }
      const asset = input.asset ?? randomUUID();
      const upload = randomUUID();
      let epoch = '0';
      let stateHead: string;
      if (input.asset) {
        const current = await client.query<{ owner: string; state_head: string; lifecycle: string;
          erasure_epoch: string }>(`SELECT a.owner, a.state_head, s.lifecycle, s.erasure_epoch::text
          FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head WHERE a.id = $1
          FOR SHARE OF a`, [asset]);
        const row = current.rows[0];
        if (!row || row.owner !== admission.actingSubject) throw new MediaMissing('media asset is unavailable');
        if (row.lifecycle !== 'active') throw new MediaStale('media asset is not active');
        epoch = row.erasure_epoch;
        stateHead = row.state_head;
      } else {
        stateHead = randomUUID();
      }
      const at = await receipt(client, { operationId, digest: admission.requestDigest,
        action: 'media.upload.reserve', outcome: 'succeeded', eventType: 'media.upload.reserved',
        payload: { asset, upload, created: !input.asset } });
      if (!input.asset) {
        await client.query(`INSERT INTO media.asset (id, variant_id, owner, media_kind, object_namespace,
          state_head, operation_id) VALUES ($1,$2,$3,'image',$4,$5,$6)`,
        [asset, assetVariant(asset), admission.actingSubject, assetNamespace(asset), stateHead, operationId]);
        await client.query(`INSERT INTO media.asset_state (id, asset_id, predecessor, disclosure,
          moderation, lifecycle, erasure_epoch, actor, authority_epoch, operation_id, data_epoch, sequence)
          VALUES ($1,$2,NULL,$3,'none','active',0,$4,$5,$6,$7,$8)`,
        [stateHead, asset, input.disclosure, admission.actingSubject, admission.authorityEpoch,
          operationId, at.dataEpoch, at.sequence]);
      }
      const reserved = await client.query<{ expires_at: Date }>(`INSERT INTO media.upload (id, asset_id,
        principal_id, operation_id, erasure_epoch, declared_media_type, declared_byte_length,
        declared_digest, quarantine_key, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, clock_timestamp() + interval '1 hour')
        RETURNING expires_at`,
      [upload, asset, admission.principalId, operationId, epoch, input.mediaType, input.byteLength,
        input.sha256, `media-quarantine/${upload}`]);
      return { asset, upload, quarantineKey: `media-quarantine/${upload}`,
        objectNamespace: assetNamespace(asset), expiresAt: reserved.rows[0]!.expires_at.toISOString(),
        stateHead, position: at, replayed: false };
    });
  }

  async readUpload(upload: string): Promise<UploadRow | null> {
    if (!uuid.test(upload)) throw new MediaInvalid('invalid upload id');
    const result = await this.pool.query(`SELECT u.id, u.asset_id, u.status, u.declared_media_type,
      u.declared_byte_length, u.declared_digest, u.quarantine_key, a.object_namespace, a.owner,
      u.expires_at <= clock_timestamp() AS expired, r.id AS representation, u.principal_id, u.reason,
      media.delivery_clearance(r) AS clearance, CASE
        WHEN media.delivery_clearance(r) = 'rejected' THEN 'restricted' ELSE r.clearance_reason END AS clearance_reason
      FROM media.upload u JOIN media.asset a ON a.id = u.asset_id
      LEFT JOIN media.representation r ON r.upload_id = u.id WHERE u.id = $1`, [upload]);
    const row = result.rows[0];
    return row ? { id: row.id, asset: row.asset_id, status: row.status, mediaType: row.declared_media_type,
      byteLength: row.declared_byte_length, sha256: row.declared_digest, quarantineKey: row.quarantine_key,
      objectNamespace: row.object_namespace, owner: row.owner, expired: row.expired,
      representation: row.representation, principal: row.principal_id, reason: row.reason,
      clearance: row.clearance, clearanceReason: row.clearance_reason } : null;
  }

  /** Activate verified bytes already present in the asset namespace, or record a rejection. */
  async settleUpload(upload: string, verdict: { status: 'activated'; sha256: string; byteLength: number;
    mediaType: MediaType; width: number; height: number } | { status: 'rejected'; reason: string },
  ): Promise<ActivatedUpload> {
    const current = await this.readUpload(upload);
    if (!current) throw new MediaMissing('media upload is unavailable');
    const operationId = `media-activate:${upload}`;
    const digest = hash(JSON.stringify({ family: 'media-upload-settle-v1', upload, verdict }));
    return transaction(this.pool, async client => {
      const previous = await prior(client, operationId, digest, 'media.upload.settle');
      const rep = async () => (await client.query<{ id: string; byte_digest: string }>(
        'SELECT id, byte_digest FROM media.representation WHERE upload_id = $1', [upload])).rows[0];
      if (previous) {
        const row = await rep();
        return { asset: current.asset, upload, representation: row?.id ?? '', sha256: row?.byte_digest ?? '',
          status: previous.outcome === 'succeeded' ? 'activated' : 'rejected', reason: previous.reason,
          position: position(previous), replayed: true };
      }
      if (verdict.status === 'rejected') {
        const at = await receipt(client, { operationId, digest, action: 'media.upload.settle',
          outcome: 'rejected', reason: verdict.reason, eventType: 'media.upload.rejected',
          payload: { asset: current.asset, upload, reason: verdict.reason } });
        await client.query(`UPDATE media.upload SET status = 'rejected', reason = $2,
          settle_operation_id = $3, settled_at = clock_timestamp() WHERE id = $1`,
        [upload, verdict.reason, operationId]);
        return { asset: current.asset, upload, representation: '', sha256: '', status: 'rejected',
          reason: verdict.reason, position: at, replayed: false };
      }
      const representation = randomUUID();
      const at = await receipt(client, { operationId, digest, action: 'media.upload.settle',
        outcome: 'succeeded', eventType: 'media.upload.activated',
        payload: { asset: current.asset, upload, representation, sha256: verdict.sha256 } });
      await client.query(`INSERT INTO media.representation (id, asset_id, kind, upload_id, byte_digest,
        byte_length, media_type, pixel_width, pixel_height, operation_id)
        VALUES ($1,$2,'original',$3,$4,$5,$6,$7,$8,$9)`,
      [representation, current.asset, upload, verdict.sha256, verdict.byteLength, verdict.mediaType,
        verdict.width, verdict.height, operationId]);
      await client.query(`INSERT INTO media.asset_state (id, asset_id, predecessor, disclosure, moderation,
        lifecycle, erasure_epoch, actor, authority_epoch, operation_id, data_epoch, sequence)
        SELECT $1, a.id, a.state_head, s.disclosure, 'suppressed', s.lifecycle, s.erasure_epoch,
          s.actor, s.authority_epoch, $2, $3, $4 FROM media.asset a
        JOIN media.asset_state s ON s.id = a.state_head
        WHERE a.id = $5 AND s.moderation <> 'suppressed'
          AND EXISTS (SELECT 1 FROM media.suppressed_digest WHERE digest = $6)`,
      [randomUUID(), operationId, at.dataEpoch, at.sequence, current.asset, verdict.sha256]);
      return { asset: current.asset, upload, representation, sha256: verdict.sha256, status: 'activated',
        reason: null, position: at, replayed: false };
    });
  }

  /** Stage two: the activated original becomes the asset head through Content's CAS.
   * Retried with the latest head, so it is also the reconciliation path. */
  async recordAssetRevision(upload: string): Promise<{ revision: string; replayed: boolean }> {
    const row = (await this.pool.query<{ asset_id: string; id: string; byte_digest: string;
      byte_length: number; media_type: string; pixel_width: number; pixel_height: number }>(
      `SELECT r.asset_id, r.id, r.byte_digest, r.byte_length, r.media_type, r.pixel_width, r.pixel_height
       FROM media.representation r WHERE r.upload_id = $1 AND r.kind = 'original'`, [upload])).rows[0];
    if (!row) throw new MediaMissing('activated original is unavailable');
    const operationId = `media-asset-revision:${upload}`;
    const manifest = assetManifest(row.asset_id, { id: row.id, sha256: row.byte_digest,
      byteLength: row.byte_length, mediaType: row.media_type, width: row.pixel_width, height: row.pixel_height });
    const attempts = [0, 1, 2, 3].map(attempt => attempt ? `${operationId}:${attempt}` : operationId);
    for (;;) {
      // A stale attempt keeps its receipt; each retry uses the next derived operation.
      const receipts = await this.pool.query<{ operation_id: string; outcome: string; revision_id: string | null }>(
        `SELECT operation_id, outcome, revision_id FROM content.receipt
         WHERE operation_id = ANY($1::text[]) AND action = 'draft.save'`, [attempts]);
      const done = receipts.rows.find(receipt => receipt.outcome === 'succeeded' && receipt.revision_id);
      if (done) return { revision: done.revision_id!, replayed: true };
      const next = attempts.find(id => !receipts.rows.some(receipt => receipt.operation_id === id));
      if (!next) break;
      const head = (await this.pool.query<{ draft_head: string | null }>(
        'SELECT draft_head FROM content.variant WHERE id = $1', [assetVariant(row.asset_id)])).rows[0];
      const saved = await this.content.saveDraft({ operationId: next,
        variant: { id: assetVariant(row.asset_id), resourceId: assetIri(row.asset_id),
          language: { kind: 'zxx' }, direction: 'none' },
        expectedHead: head?.draft_head ?? null, model: 'media-asset-v1', sourceRevision: null,
        provenance: { kind: 'media-upload-activation-v1', upload, representation: row.id },
        serializedJson: manifest });
      if (saved.outcome === 'succeeded' && saved.revisionId) return { revision: saved.revisionId, replayed: saved.replayed };
    }
    throw new MediaStale('asset head kept moving');
  }

  /** Activated originals whose asset revision was never recorded (lost second stage). */
  async unrecordedActivations(limit = 100): Promise<string[]> {
    const result = await this.pool.query<{ upload_id: string }>(`SELECT r.upload_id FROM media.representation r
      JOIN media.asset a ON a.id = r.asset_id
      WHERE r.kind = 'original' AND NOT EXISTS (SELECT 1 FROM content.revision v
        WHERE v.variant_id = a.variant_id AND v.model = 'media-asset-v1'
          AND v.body @> jsonb_build_object('representations', jsonb_build_array(
            jsonb_build_object('id', r.id::text))))
      ORDER BY r.created_at, r.id LIMIT $1`, [limit]);
    return result.rows.map(row => row.upload_id);
  }

  async readAsset(asset: string) {
    if (!uuid.test(asset)) throw new MediaInvalid('invalid asset id');
    const result = await this.pool.query(`SELECT a.id, a.owner, a.state_head, s.disclosure, s.moderation,
      s.lifecycle, s.erasure_epoch::text AS erasure_epoch, v.draft_head, rev.body
      FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head
      LEFT JOIN content.variant v ON v.id = a.variant_id
      LEFT JOIN content.revision rev ON rev.id = v.draft_head AND rev.availability = 'available'
      WHERE a.id = $1`, [asset]);
    const row = result.rows[0];
    if (!row) return null;
    return { asset: row.id as string, owner: row.owner as string, state: row.state_head as string,
      disclosure: row.disclosure as string, moderation: row.moderation as string,
      lifecycle: row.lifecycle as string, erasureEpoch: row.erasure_epoch as string,
      revision: row.draft_head as string | null,
      representations: (row.body?.representations ?? []) as Array<{ id: string; sha256: string;
        mediaType: string; width: number; height: number; byteLength: number }> };
  }

  /** Disclosure/lifecycle CAS. Deletion and erasure advance the erasure epoch;
   * erasure also marks every representation erased in the same transaction. */
  async changeState(admission: MediaAdmission, input: AssetStateChangeInput,
    preservation?: PreservationFence,
  ): Promise<CommandOutcome> {
    checkAdmission(admission);
    if (!uuid.test(input.asset) || !uuid.test(input.expectedState)
      || !['private', 'public'].includes(input.disclosure)
      || !['active', 'deleted', 'erased'].includes(input.lifecycle)) {
      throw new MediaInvalid('asset state change is invalid');
    }
    const operationId = `media-state:${admission.admissionId}`;
    const write = () =>
      transaction<CommandOutcome>(this.pool, async (client) => {
      const previous = await prior(client, operationId, admission.requestDigest, 'media.asset.state');
      if (previous) {
        const state = await client.query<{ id: string; predecessor: string }>(
          'SELECT id, predecessor FROM media.asset_state WHERE operation_id = $1', [operationId]);
        return { outcome: previous.outcome as CommandOutcome['outcome'], id: state.rows[0]?.id ?? null,
          predecessor: state.rows[0]?.predecessor ?? null, position: position(previous), replayed: true };
      }
      const current = await client.query<{ owner: string; state_head: string; lifecycle: string;
        erasure_epoch: string; moderation: string;
        }>(`SELECT a.owner, a.state_head, s.lifecycle,
        s.erasure_epoch::text, s.moderation FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head
        WHERE a.id = $1 FOR UPDATE OF a`, [input.asset]);
      const row = current.rows[0];
      if (!row || row.owner !== admission.actingSubject) throw new MediaMissing('media asset is unavailable');
      const invalid = row.lifecycle === 'erased'
        || (row.lifecycle === 'deleted' && input.lifecycle === 'deleted');
      if (row.state_head !== input.expectedState || invalid) {
        const at = await receipt(client, { operationId, digest: admission.requestDigest,
          action: 'media.asset.state', outcome: 'stale_head',
          reason: invalid ? 'lifecycle-terminal' : 'expected state differs',
          eventType: 'media.asset.state.stale', payload: { asset: input.asset, expected: input.expectedState } });
        return { outcome: 'stale_head', id: null, predecessor: row.state_head, position: at, replayed: false };
      }
      const advances = input.lifecycle !== 'active' && input.lifecycle !== row.lifecycle;
      const epoch = advances ? String(BigInt(row.erasure_epoch) + 1n) : row.erasure_epoch;
      const id = randomUUID();
      const at = await receipt(client, { operationId, digest: admission.requestDigest,
        action: 'media.asset.state', outcome: 'succeeded', eventType: 'media.asset.state.changed',
        payload: { asset: input.asset, state: id, disclosure: input.disclosure, lifecycle: input.lifecycle } });
      await client.query(`INSERT INTO media.asset_state (id, asset_id, predecessor, disclosure, moderation,
        lifecycle, erasure_epoch, actor, authority_epoch, operation_id, data_epoch, sequence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, input.asset, row.state_head, input.disclosure, row.moderation, input.lifecycle, epoch,
        admission.actingSubject, admission.authorityEpoch, operationId, at.dataEpoch, at.sequence]);
      if (input.lifecycle === 'erased') {
        await client.query(`UPDATE media.representation SET availability = 'erased'
          WHERE asset_id = $1 AND availability = 'available'`, [input.asset]);
      }
      return { outcome: 'succeeded', id, predecessor: row.state_head, position: at, replayed: false };
    });
    if (input.lifecycle === 'erased') {
      if (!preservation)
        throw new MediaFenced('media erasure requires the Access preservation fence');
      const result = await withPreservationFence(
        preservation,
        assetIri(input.asset),
        operationId,
        write,
      );
      if (result.held) throw new MediaFenced('media is retained under a preservation hold');
      return result.value;
    }
    return write();
  }

  /** Avatar selection CAS: one Use for the exact current asset revision and original,
   * or an explicit removal, and the new head in one transaction. */
  async selectAvatar(admission: MediaAdmission, input: AvatarSelectionInput): Promise<CommandOutcome> {
    checkAdmission(admission);
    if (!nativeId.test(input.target)
      || (input.context !== DEFAULT_MEDIA_CONTEXT && !nativeId.test(input.context))
      || (input.expectedSelection !== null && !uuid.test(input.expectedSelection))
      || (input.asset !== null && !uuid.test(input.asset))
      || (input.crop !== null && (input.asset === null || !crop.test(input.crop)))) {
      throw new MediaInvalid('avatar selection is invalid');
    }
    const operationId = `media-avatar:${admission.admissionId}`;
    return transaction(this.pool, async client => {
      const previous = await prior(client, operationId, admission.requestDigest, 'media.selection.change');
      if (previous) {
        const selected = await client.query<{ id: string; predecessor: string | null }>(
          'SELECT id, predecessor FROM media.selection_revision WHERE operation_id = $1', [operationId]);
        return { outcome: previous.outcome as CommandOutcome['outcome'], id: selected.rows[0]?.id ?? null,
          predecessor: selected.rows[0]?.predecessor ?? null, position: position(previous), replayed: true };
      }
      await client.query(`INSERT INTO media.selection_slot (target, context, role, policy)
        VALUES ($1,$2,'avatar',$3) ON CONFLICT DO NOTHING`, [input.target, input.context, AVATAR_POLICY]);
      const slot = await client.query<{ head: string | null }>(`SELECT head FROM media.selection_slot
        WHERE target = $1 AND context = $2 AND role = 'avatar' FOR UPDATE`, [input.target, input.context]);
      const head = slot.rows[0]?.head ?? null;
      let basis: { revision: string; representation: string } | null = null;
      if (input.asset) {
        const asset = await client.query<{ owner: string; lifecycle: string; draft_head: string | null;
          body: { representations?: Array<{ id: string }> } | null }>(`SELECT a.owner, s.lifecycle,
          v.draft_head, rev.body FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head
          LEFT JOIN content.variant v ON v.id = a.variant_id
          LEFT JOIN content.revision rev ON rev.id = v.draft_head AND rev.availability = 'available'
          WHERE a.id = $1 FOR SHARE OF a`, [input.asset]);
        const row = asset.rows[0];
        // v1 admits only the actor's own active asset; no related or inherited image.
        if (!row || row.owner !== admission.actingSubject || row.lifecycle !== 'active'
          || !row.draft_head || !row.body?.representations?.[0]) {
          throw new MediaMissing('media asset is unavailable for selection');
        }
        basis = { revision: row.draft_head, representation: row.body.representations[0].id };
      }
      if (head !== input.expectedSelection) {
        const at = await receipt(client, { operationId, digest: admission.requestDigest,
          action: 'media.selection.change', outcome: 'stale_head', reason: 'expected selection differs',
          eventType: 'media.selection.stale', payload: { target: input.target, context: input.context } });
        return { outcome: 'stale_head', id: null, predecessor: head, position: at, replayed: false };
      }
      const id = randomUUID();
      const use = basis ? randomUUID() : null;
      const at = await receipt(client, { operationId, digest: admission.requestDigest,
        action: 'media.selection.change', outcome: 'succeeded', eventType: 'media.selection.changed',
        payload: { target: input.target, context: input.context, selection: id, removed: !basis } });
      if (basis && input.asset) {
        await client.query(`INSERT INTO media.use (id, asset_id, asset_variant_id, asset_revision_id,
          representation_id, target, context, role, crop, actor, operation_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'avatar',$8,$9,$10)`,
        [use, input.asset, assetVariant(input.asset), basis.revision, basis.representation, input.target,
          input.context, input.crop, admission.actingSubject, operationId]);
      }
      await client.query(`INSERT INTO media.selection_revision (id, target, context, role, predecessor,
        use_id, actor, authority_epoch, operation_id, data_epoch, sequence)
        VALUES ($1,$2,$3,'avatar',$4,$5,$6,$7,$8,$9,$10)`,
      [id, input.target, input.context, head, use, admission.actingSubject, admission.authorityEpoch,
        operationId, at.dataEpoch, at.sequence]);
      return { outcome: 'succeeded', id, predecessor: head, position: at, replayed: false };
    });
  }

  /** Exact current basis for image-only publication items: the actor's own public,
   * active asset head and its original, in the requested order. */
  async publicationBasis(assets: readonly string[], actor: string): Promise<PublicationItemBasis[]> {
    if (assets.some(asset => !uuid.test(asset)) || !nativeId.test(actor)) {
      throw new MediaInvalid('publication items are invalid');
    }
    const result = await this.pool.query(`SELECT a.id AS asset, v.draft_head AS revision, p.id AS representation,
      p.byte_digest, p.media_type, p.pixel_width, p.pixel_height
      FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head
      JOIN content.variant v ON v.id = a.variant_id
      JOIN content.revision rev ON rev.id = v.draft_head AND rev.availability = 'available'
      JOIN media.representation p ON p.asset_id = a.id AND p.availability = 'available'
        AND p.id::text = rev.body -> 'representations' -> 0 ->> 'id'
      WHERE a.id = ANY($1::uuid[]) AND a.owner = $2 AND s.lifecycle = 'active'
        AND s.moderation = 'none' AND s.disclosure = 'public'`, [assets, actor]);
    const found = new Map(result.rows.map(row => [row.asset as string, row]));
    return assets.map(asset => {
      const row = found.get(asset);
      if (!row) throw new MediaMissing('publication image is unavailable');
      return { asset, revision: row.revision, representation: row.representation, sha256: row.byte_digest,
        mediaType: row.media_type, width: row.pixel_width, height: row.pixel_height };
    });
  }

  /** Publication item Uses under one media receipt; replay returns without new rows. */
  async createPublicationUses(admissionId: string, actor: string, target: string,
    items: ReadonlyArray<PublicationItemBasis & { use: string }>): Promise<ContentPosition> {
    const operationId = `media-set:${admissionId}`;
    const digest = hash(JSON.stringify({ family: 'media-set-uses-v1', target, items }));
    return transaction(this.pool, async client => {
      const previous = await prior(client, operationId, digest, 'media.use.create');
      if (previous) return position(previous);
      const at = await receipt(client, { operationId, digest, action: 'media.use.create',
        outcome: 'succeeded', eventType: 'media.use.created',
        payload: { target, uses: items.map(item => item.use) } });
      for (const item of items) {
        await client.query(`INSERT INTO media.use (id, asset_id, asset_variant_id, asset_revision_id,
          representation_id, target, context, role, crop, actor, operation_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'publication-item',NULL,$8,$9)`,
        [item.use, item.asset, assetVariant(item.asset), item.revision, item.representation, target,
          DEFAULT_MEDIA_CONTEXT, actor, operationId]);
      }
      return at;
    });
  }

  /** Delivery basis for one publication item Use. */
  async itemDelivery(use: string) {
    if (!uuid.test(use)) return null;
    const result = await this.pool.query(`SELECT u.target, p.byte_digest, p.media_type, p.byte_length,
      p.pixel_width, p.pixel_height, p.availability, media.delivery_clearance(p) AS clearance, s.disclosure, s.moderation, s.lifecycle, a.object_namespace
      FROM media.use u JOIN media.asset a ON a.id = u.asset_id JOIN media.asset_state s ON s.id = a.state_head
      JOIN media.representation p ON p.id = u.representation_id
      WHERE u.id = $1 AND u.role = 'publication-item' AND media.delivery_clearance(p) = 'cleared'`, [use]);
    const row = result.rows[0];
    return row ? { target: row.target as string, sha256: row.byte_digest as string,
      mediaType: row.media_type as string, byteLength: row.byte_length as number,
      width: row.pixel_width as number, height: row.pixel_height as number,
      availability: row.availability as string, clearance: row.clearance as Clearance, disclosure: row.disclosure as string,
      moderation: row.moderation as string, lifecycle: row.lifecycle as string,
      objectNamespace: row.object_namespace as string } : null;
  }

  /** Exact current avatar bytes linked to the requested Work and context. */
  async assetDelivery(asset: string, target: string, context = DEFAULT_MEDIA_CONTEXT) {
    if (!uuid.test(asset) || !nativeId.test(target)
      || (context !== DEFAULT_MEDIA_CONTEXT && !nativeId.test(context))) return null;
    const result = await this.pool.query(`SELECT p.byte_digest, p.media_type, p.byte_length, p.availability, media.delivery_clearance(p) AS clearance, a.owner, uploader.principal_id AS uploader,
        st.disclosure, st.moderation, st.lifecycle, a.object_namespace
      FROM media.selection_slot s
      JOIN media.selection_revision r ON r.id = s.head
      JOIN media.use u ON u.id = r.use_id AND u.asset_id = $1
      JOIN media.representation p ON p.id = u.representation_id
      JOIN media.asset a ON a.id = p.asset_id
      JOIN media.asset_state st ON st.id = a.state_head
      JOIN media.representation original ON original.id = CASE WHEN p.kind = 'original' THEN p.id ELSE p.source_id END
        AND original.kind = 'original'
      JOIN media.upload uploader ON uploader.id = original.upload_id
      WHERE s.target = $2 AND s.context = $3 AND s.role = 'avatar' AND a.id = $1
      LIMIT 1`, [asset, target, context]);
    const row = result.rows[0];
    return row ? { sha256: row.byte_digest as string, mediaType: row.media_type as string,
      byteLength: row.byte_length as number, availability: row.availability as string,
      clearance: row.clearance as Clearance, owner: row.owner as string, uploader: row.uploader as string,
      disclosure: row.disclosure as string, moderation: row.moderation as string,
      lifecycle: row.lifecycle as string, objectNamespace: row.object_namespace as string } : null;
  }

  /** Internal governance capability. Each call denies all exact-byte copies immediately
   * and advances at most 100 asset histories. Continue with the returned asset cursor. */
  async suppressIdenticalCopies(originalDigest: string, after: string | null = null, limit = 100): Promise<{
    suppressed: number; continuation: string | null }> {
    if (!sha.test(originalDigest) || (after !== null && !uuid.test(after))
      || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new MediaInvalid('invalid copy suppression');
    await transaction(this.pool, async client => {
      await client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`media-copy:${originalDigest}`]);
      const marker = await client.query('INSERT INTO media.suppressed_digest (digest) VALUES ($1) ON CONFLICT DO NOTHING RETURNING digest', [originalDigest]);
      if (marker.rowCount) {
        const operationId = `media-copy-digest:${originalDigest}`;
        await receipt(client, { operationId, digest: hash(operationId), action: 'media.copy.suppress',
          outcome: 'succeeded', eventType: 'media.copy.suppression.started', payload: { digest: originalDigest } });
      }
    });
    return transaction(this.pool, async client => {
      await client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      const candidates = await client.query<{ id: string }>(`SELECT DISTINCT asset_id AS id FROM media.representation
        WHERE kind = 'original' AND byte_digest = $1 AND ($2::uuid IS NULL OR asset_id > $2)
        ORDER BY asset_id LIMIT $3`, [originalDigest, after, limit + 1]);
      const batch = candidates.rows.slice(0, limit);
      let suppressed = 0;
      for (const asset of batch) {
        const row = (await client.query(`SELECT a.state_head, s.* FROM media.asset a
          JOIN media.asset_state s ON s.id = a.state_head WHERE a.id = $1 FOR UPDATE OF a`, [asset.id])).rows[0]!;
        if (row.moderation === 'suppressed' || row.lifecycle === 'erased') continue;
        const operationId = `media-copy:${originalDigest}:${asset.id}`;
        const id = randomUUID();
        const at = await receipt(client, { operationId, digest: hash(operationId), action: 'media.copy.suppress',
          outcome: 'succeeded', eventType: 'media.copy.suppressed', payload: { asset: asset.id } });
        await client.query(`INSERT INTO media.asset_state (id, asset_id, predecessor, disclosure, moderation,
          lifecycle, erasure_epoch, actor, authority_epoch, operation_id, data_epoch, sequence)
          VALUES ($1,$2,$3,$4,'suppressed',$5,$6,$7,$8,$9,$10,$11)`,
        [id, asset.id, row.state_head, row.disclosure, row.lifecycle, row.erasure_epoch, row.actor,
          row.authority_epoch, operationId, at.dataEpoch, at.sequence]);
        suppressed++;
      }
      return { suppressed, continuation: candidates.rows.length > limit ? batch.at(-1)!.id : null };
    });
  }

  /** Staff-only primitive after a committed governance plan. Reconciles an exact
   * owner receipt before testing the saved state, including after a lost response. */
  async moderateOriginal(
    operationId: string,
    source: string,
    expectedState: string,
    suppressed: boolean,
  ): Promise<string> {
    if (!uuid.test(source) || !uuid.test(expectedState) || operationId.length > 160) {
      throw new MediaInvalid('invalid moderation original');
    }
    const requestDigest = hash(JSON.stringify([operationId, source, expectedState, suppressed]));
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operationId]);
      if (await prior(client, operationId, requestDigest, 'media.screen.review'))
        return operationId;
      const row = (
        await client.query(
          `SELECT a.id,a.state_head,s.*,p.byte_digest FROM media.asset a
        JOIN media.asset_state s ON s.id = a.state_head
        JOIN media.representation p ON p.asset_id = a.id AND p.id = $1 AND p.kind = 'original'
        WHERE p.availability = 'available' FOR UPDATE OF a,p`,
          [source],
        )
      ).rows[0];
      if (!row || row.state_head !== expectedState || row.lifecycle !== 'active')
        throw new MediaStale('media state changed');
      if (
        !suppressed &&
        (
          await client.query('SELECT 1 FROM media.suppressed_digest WHERE digest = $1', [
            row.byte_digest,
          ])
        ).rowCount
      )
        throw new MediaCopyRestorationUnavailable('identical-copy reversal owner is unavailable');
      const at = await receipt(client, {
        operationId,
        digest: requestDigest,
        action: 'media.screen.review',
        outcome: 'succeeded',
        eventType: 'media.screen.reviewed',
        payload: { asset: row.asset_id, source, suppressed },
      });
      const effect = hash(operationId);
      const decision = `${effect.slice(0, 8)}-${effect.slice(8, 12)}-${effect.slice(12, 16)}-${effect.slice(16, 20)}-${effect.slice(20, 32)}`;
      await client.query(
        `INSERT INTO media.clearance_decision (id,source_id,decision_id,clearance,operation_id)
        VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), source, decision, suppressed ? 'rejected' : 'cleared', operationId],
      );
      await client.query(
        `INSERT INTO media.asset_state (id,asset_id,predecessor,disclosure,moderation,
        lifecycle,erasure_epoch,actor,authority_epoch,operation_id,data_epoch,sequence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          row.asset_id,
          row.state_head,
          row.disclosure,
          suppressed ? 'suppressed' : 'none',
          row.lifecycle,
          row.erasure_epoch,
          row.actor,
          row.authority_epoch,
          operationId,
          at.dataEpoch,
          at.sequence,
        ],
      );
      return operationId;
    });
  }

  /** Current owner result for an admission; used for replay after Access denies a re-claim. */
  async readOutcome(operationId: string): Promise<{ outcome: string; position: ContentPosition } | null> {
    const result = await this.pool.query<{ outcome: string; data_epoch: string; sequence: string }>(
      `SELECT outcome, data_epoch, sequence::text AS sequence FROM content.receipt WHERE operation_id = $1`,
      [operationId]);
    const row = result.rows[0];
    return row ? { outcome: row.outcome, position: position(row) } : null;
  }

  /** Fence an admission whose dispatch Access closed; an existing outcome is returned unchanged. */
  async cancel(operationId: string, action: string, requestDigest: string): Promise<{
    outcome: 'succeeded' | 'cancelled'; position: ContentPosition }> {
    if (!/^media-(upload|state|avatar):[0-9a-f-]{36}$/.test(operationId) || !sha.test(requestDigest)) {
      throw new MediaInvalid('invalid media admission fence');
    }
    return transaction(this.pool, async client => {
      const previous = await prior(client, operationId, requestDigest, action);
      if (previous) {
        return { outcome: previous.outcome === 'succeeded' ? 'succeeded' : 'cancelled', position: position(previous) };
      }
      const at = await receipt(client, { operationId, digest: requestDigest, action, outcome: 'rejected',
        reason: 'admission-fenced', eventType: 'media.admission.fenced', payload: { operationId } });
      return { outcome: 'cancelled', position: at };
    });
  }

  /** Batched avatar basis: at most two primary-key slot probes per target in one query.
   * The requested context wins when it has a slot, including an explicit removal. */
  async avatarRows(targets: readonly string[], context: string): Promise<{ rows: Map<string, AvatarRow>;
    generation: ContentPosition }> {
    if (targets.length > MAX_SUMMARY_TARGETS || targets.some(target => !nativeId.test(target))
      || (context !== DEFAULT_MEDIA_CONTEXT && !nativeId.test(context))) {
      throw new MediaInvalid('avatar hydration request is invalid');
    }
    const contexts = context === DEFAULT_MEDIA_CONTEXT ? [context] : [context, DEFAULT_MEDIA_CONTEXT];
    const result = await this.pool.query(`WITH owner AS (
        SELECT data_epoch, sequence::text AS sequence FROM content.owner_control WHERE singleton),
      wanted AS (SELECT t.target, c.context, c.rank FROM unnest($1::text[]) AS t(target)
        CROSS JOIN unnest($2::text[]) WITH ORDINALITY AS c(context, rank)),
      chosen AS (SELECT DISTINCT ON (w.target) w.target, s.context, media.delivered_selection(s) AS head FROM wanted w
        JOIN media.selection_slot s ON s.target = w.target AND s.context = w.context AND s.role = 'avatar'
        ORDER BY w.target, w.rank)
      SELECT c.target, c.context, c.head AS selection, r.sequence::text AS selection_position,
        u.id AS use, u.asset_id, u.crop, p.id AS representation, p.byte_digest, p.media_type, p.byte_length,
        p.pixel_width, p.pixel_height, p.availability, media.delivery_clearance(p) AS clearance, st.disclosure, st.moderation, st.lifecycle,
        st.sequence::text AS state_position, o.data_epoch AS owner_epoch, o.sequence AS owner_sequence
      FROM owner o LEFT JOIN chosen c ON true
      LEFT JOIN media.selection_revision r ON r.id = c.head
      LEFT JOIN media.use u ON u.id = r.use_id
      LEFT JOIN media.asset a ON a.id = u.asset_id
      LEFT JOIN media.asset_state st ON st.id = a.state_head
      LEFT JOIN media.representation p ON p.id = u.representation_id`, [targets, contexts]);
    const rows = new Map<string, AvatarRow>();
    for (const row of result.rows) {
      if (!row.target) continue;
      rows.set(row.target, { target: row.target, context: row.context, selection: row.selection,
        selectionPosition: row.selection_position, use: row.use, asset: row.asset_id, crop: row.crop,
        representation: row.representation, sha256: row.byte_digest, mediaType: row.media_type,
        byteLength: row.byte_length, width: row.pixel_width, height: row.pixel_height,
        availability: row.availability, clearance: row.clearance, disclosure: row.disclosure, moderation: row.moderation,
        lifecycle: row.lifecycle, statePosition: row.state_position });
    }
    const owner = result.rows[0]!;
    return { rows, generation: { owner: 'content', dataEpoch: owner.owner_epoch, sequence: owner.owner_sequence } };
  }

  /** Public delivery follows the cleared head, retaining the previous cleared image during screening. */
  avatarDelivery(selection: string): Promise<(AvatarRow & { objectNamespace: string }) | null> {
    return this.avatarSelectionBasis(selection, false);
  }

  /** Profile writes bind the requested current head before its asynchronous screen completes. */
  avatarSelection(selection: string): Promise<(AvatarRow & { objectNamespace: string }) | null> {
    return this.avatarSelectionBasis(selection, true);
  }

  private async avatarSelectionBasis(selection: string, requested: boolean): Promise<(AvatarRow & { objectNamespace: string }) | null> {
    if (!uuid.test(selection)) return null;
    const result = await this.pool.query(`SELECT r.target, r.context, r.id AS selection, u.id AS use,
      u.asset_id, u.crop, p.id AS representation, p.byte_digest, p.media_type, p.byte_length,
      p.pixel_width, p.pixel_height, p.availability, media.delivery_clearance(p) AS clearance, st.disclosure, st.moderation, st.lifecycle,
      a.object_namespace FROM media.selection_revision r
      JOIN media.selection_slot s ON s.target = r.target AND s.context = r.context AND s.role = r.role
        AND (CASE WHEN $2 THEN s.head ELSE media.delivered_selection(s) END) = r.id
      JOIN media.use u ON u.id = r.use_id JOIN media.asset a ON a.id = u.asset_id
      JOIN media.asset_state st ON st.id = a.state_head
      JOIN media.representation p ON p.id = u.representation_id WHERE r.id = $1`, [selection, requested]);
    const row = result.rows[0];
    return row ? { target: row.target, context: row.context, selection: row.selection,
      selectionPosition: null, use: row.use, asset: row.asset_id, crop: row.crop,
      representation: row.representation, sha256: row.byte_digest, mediaType: row.media_type,
      byteLength: row.byte_length, width: row.pixel_width, height: row.pixel_height,
      availability: row.availability, clearance: row.clearance, disclosure: row.disclosure, moderation: row.moderation,
      lifecycle: row.lifecycle, statePosition: null, objectNamespace: row.object_namespace } : null;
  }
}

/** A disclosable avatar image: public, unsuppressed, active, available and within rendition bounds. */
function avatarEligible(row: Pick<AvatarRow, 'use' | 'disclosure' | 'moderation' | 'lifecycle'
  | 'availability' | 'clearance' | 'mediaType' | 'width' | 'height' | 'byteLength'>, screening = false): boolean {
  return Boolean(row.use) && row.disclosure === 'public' && row.moderation === 'none'
    && row.lifecycle === 'active' && row.availability === 'available'
    && (row.clearance === 'cleared' || (screening && row.clearance === 'screening'))
    && MEDIA_TYPES.includes(row.mediaType as MediaType)
    && (row.width ?? Infinity) <= AVATAR_LIMITS.maxPixels && (row.height ?? Infinity) <= AVATAR_LIMITS.maxPixels
    && (row.byteLength ?? Infinity) <= AVATAR_LIMITS.maxBytes;
}

/** Public image delivery always requires clearance. */
export function avatarImageEligible(row: Parameters<typeof avatarEligible>[0]): boolean {
  return avatarEligible(row);
}

/** Writes may reference a screening image; held and rejected images remain ineligible. */
export function avatarSelectionEligible(row: Parameters<typeof avatarEligible>[0]): boolean {
  return avatarEligible(row, true);
}
