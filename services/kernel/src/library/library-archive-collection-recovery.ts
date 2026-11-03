import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import { admitGroup } from '../access/gates/admission.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId } from '../route/route.ts';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createCollectionCommands } from './collections.ts';
import {
  ArchiveValidationError,
  LIBRARY_ARCHIVE_LIMITS,
  LIBRARY_ARCHIVE_RECOVERY_LIMITS,
  type ArchiveRecord,
  decodeLibraryArchive,
} from './library-archive.ts';
import type { LibraryArchiveManifest } from './library-export-format.ts';
import { createPins } from './pins.ts';
import { resolveSubject, SubjectIdentityUnavailableError } from './subject-anchor.ts';
import { isOrdinalKey } from './ordinal.ts';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const cleanupLimit = LIBRARY_ARCHIVE_RECOVERY_LIMITS.cleanupRows;
const applyLimit = LIBRARY_ARCHIVE_RECOVERY_LIMITS.applyCommands;
const pageLimit = LIBRARY_ARCHIVE_RECOVERY_LIMITS.previewPage;
const lifetime = LIBRARY_ARCHIVE_RECOVERY_LIMITS.lifetimeMs;
const sectionReasons: Record<string, string> = {
  entries: 'Entry state is not restored by Collection recovery.',
  labels: 'Labels are not restored by Collection recovery.',
  assignments: 'Label assignments are not restored by Collection recovery.',
  sessions: 'Progress sessions are retained as unsupported archive evidence.',
  units: 'Progress units are retained as unsupported archive evidence.',
  history: 'Progress history is retained as unsupported archive evidence.',
  holdings: 'Holdings are retained as unsupported archive evidence.',
  collections: 'Only one explicitly selected curated Collection is eligible.',
  collectionPins: 'A pin is restored only for the sole archived pin and a current reviewed owner revision.',
  occurrences: 'Only explicitly selected occurrences of the selected curated Collection are eligible.',
  bangumiUploads: 'Bangumi uploads are retained as unsupported archive evidence.',
  bangumiEvidence: 'Bangumi evidence is retained as unsupported archive evidence.',
  malImports: 'MAL imports are retained as unsupported archive evidence.',
  malEvidence: 'MAL evidence is retained as unsupported archive evidence.',
};

type RecoveryState = 'preview' | 'reviewed' | 'applying' | 'complete' | 'partial' | 'cancelled' | 'expired';
type RecoveryRoot = {
  route: number;
  accountId: string;
  uploadId: string;
  requestKey: string;
  uploadDigest: string;
  manifest: LibraryArchiveManifest | Record<string, never>;
  coverage: unknown[];
  sourcePins: string[] | null;
  createdAt: string;
  expiresAt: string;
  state: RecoveryState;
  sourceRecordCount: number;
  sourceMembershipComplete: boolean;
  selectedCollectionId: string | null;
  selectedCount: number;
  reviewId: string | null;
  reviewEpoch: number;
  reviewKey: string | null;
  reviewRequestDigest: string | null;
  reviewDigest: string | null;
  reviewSnapshot: ReviewSnapshot | null;
  nativeCollectionId: string | null;
  lastAddedMemberId: string | null;
  pinState: 'none' | 'pending' | 'applied' | 'unsupported';
  pinReason: string | null;
  pinRevision: string | null;
  pinAfter: string | null;
  cancelRequested: boolean;
  inflightAction: 'create' | 'member' | 'note' | 'order' | 'pin' | null;
  inflightSourceId: string | null;
  leaseId: string | null;
  leaseUntil: string | null;
};
type RecoveryRecord = {
  collectionId: string;
  sourceId: string;
  sourceSubjectId: string | null;
  title: string | null;
  description: string | null;
  metadataValid: boolean;
  visibility: string | null;
  membershipKind: string | null;
  builtinKind: string | null;
  presentationKind: string | null;
  memberCount: number;
  orderedCount: number;
  orderKey: string;
  orderPresent: boolean;
  note: string | null;
  notePresent: boolean;
  noteValid: boolean;
  recordKind: 'collection' | 'occurrence';
};
type ReviewMapping = {
  sourceSubjectId: string;
  targetSubjectId: string | null;
  currentSubjectId: string | null;
  state: 'mapped' | 'unresolved' | 'canonical-changed';
};
type ReviewSnapshot = {
  reviewId: string;
  reviewEpoch: number;
  collection: {
    sourceId: string;
    title: string;
    description: string | null;
    memberCount: number;
    visibility: string | null;
    membershipKind: string | null;
    presentationKind: string | null;
  };
  selectedOccurrenceIds: string[];
  mappings: ReviewMapping[];
  operands: Array<{
    memberId: string;
    subjectId: string | null;
    targetSubjectId: string | null;
    orderKey: string;
    orderPresent: boolean;
    note: string | null;
    notePresent: boolean;
  }>;
  completeOrder: boolean;
  completeMembership: boolean;
};
type RootRow = {
  upload_id: string;
  account_id: string;
  request_key: string;
  upload_digest: string;
  manifest: LibraryArchiveManifest | Record<string, never>;
  coverage: unknown[];
  source_pins: string[] | null;
  created_at: string;
  expires_at: string;
  state: RecoveryState;
  source_record_count: number;
  source_membership_complete: boolean;
  selected_collection_id: string | null;
  selected_count: number;
  review_id: string | null;
  review_epoch: string;
  review_key: string | null;
  review_request_digest: string | null;
  review_digest: string | null;
  review_snapshot: ReviewSnapshot | null;
  native_collection_id: string | null;
  last_added_member_id: string | null;
  pin_state: RecoveryRoot['pinState'];
  pin_reason: string | null;
  pin_revision: string | null;
  pin_after: string | null;
  cancel_requested: boolean;
  inflight_action: RecoveryRoot['inflightAction'];
  inflight_source_id: string | null;
  lease_id: string | null;
  lease_until: string | null;
};
type RecoveryDependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  routeKey: Uint8Array;
  clock: KernelClock;
  /** Test seam for a lost acknowledgement between a native receipt and the recovery checkpoint. */
  afterNativeEffect?: (kind: 'create' | 'member' | 'note' | 'order' | 'pin', sourceId?: string) => Promise<void>;
};
type ReviewInput = {
  collectionId: string;
  selectedOccurrenceIds: string[];
  mappings: Array<{ sourceSubjectId: string; targetSubjectId: string | null }>;
};

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const digestOf = (value: unknown) => {
  const serialized = canonicalize(value);
  if (typeof serialized !== 'string') throw new TypeError('Recovery operands must be canonical JSON');
  return hash(serialized);
};
const safeString = (value: unknown): string | null =>
  typeof value === 'string' && value.isWellFormed() && !value.includes('\0') ? value : null;
const validText = (value: unknown, maxCodePoints: number, maxBytes: number, empty: boolean): value is string =>
  typeof value === 'string' &&
  value.isWellFormed() &&
  !value.includes('\0') &&
  (empty || Array.from(value).length > 0) &&
  Array.from(value).length <= maxCodePoints &&
  Buffer.byteLength(value, 'utf8') <= maxBytes;
const abortIfRequested = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Request cancelled', 'AbortError');
};
const cursorEpoch = (root: RecoveryRoot) => Math.max(1, root.reviewEpoch);
function itemFailure(error: unknown, operation: 'add' | 'note' | 'order') {
  if (!(error instanceof ProblemError)) return null;
  if (operation === 'add' && ['collection_full', 'conflict', 'not_found'].includes(error.code))
    return { state: error.code === 'not_found' ? 'unresolved' : 'failed', reason: error.code } as const;
  if (operation === 'note' && ['conflict', 'not_found'].includes(error.code))
    return { state: 'failed', reason: error.code } as const;
  if (operation === 'order' && ['conflict', 'collection_move_unsupported', 'not_found'].includes(error.code))
    return { state: error.code === 'collection_move_unsupported' ? 'unsupported' : 'failed', reason: error.code } as const;
  return null;
}
function subjectUnavailable(error: unknown) {
  return error instanceof SubjectIdentityUnavailableError ||
    (error instanceof ProblemError && ['forbidden', 'not_found'].includes(error.code));
}
const notFound = () => new ProblemError('not_found');
const conflict = () => new ProblemError('conflict');

function accountOwner(actor: Actor, scopes: readonly string[] = []) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (routeOf(actor.accountId) === null) throw new ProblemError('forbidden');
  if (scopes.some((scope) => !actor.scopes.includes(scope))) throw new ProblemError('forbidden');
  return actor;
}
function rowValue(row: RootRow): RecoveryRoot {
  return {
    route: routeOf(row.account_id)!,
    accountId: row.account_id,
    uploadId: row.upload_id,
    requestKey: row.request_key,
    uploadDigest: row.upload_digest,
    manifest: row.manifest,
    coverage: row.coverage,
    sourcePins: row.source_pins,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    state: row.state,
    sourceRecordCount: row.source_record_count,
    sourceMembershipComplete: row.source_membership_complete,
    selectedCollectionId: row.selected_collection_id,
    selectedCount: row.selected_count,
    reviewId: row.review_id,
    reviewEpoch: Number(row.review_epoch),
    reviewKey: row.review_key,
    reviewRequestDigest: row.review_request_digest,
    reviewDigest: row.review_digest,
    reviewSnapshot: row.review_snapshot,
    nativeCollectionId: row.native_collection_id,
    lastAddedMemberId: row.last_added_member_id,
    pinState: row.pin_state,
    pinReason: row.pin_reason,
    pinRevision: row.pin_revision,
    pinAfter: row.pin_after,
    cancelRequested: row.cancel_requested,
    inflightAction: row.inflight_action,
    inflightSourceId: row.inflight_source_id,
    leaseId: row.lease_id,
    leaseUntil: row.lease_until,
  };
}

function rootSelect() {
  return `SELECT upload_id::text,account_id::text,request_key,upload_digest,manifest,coverage,source_pins,
    created_at::text,expires_at::text,state,source_record_count,source_membership_complete,
    selected_collection_id::text,selected_count,review_id::text,review_epoch::text,review_key,
    review_request_digest,review_digest,review_snapshot,native_collection_id::text,last_added_member_id::text,
    pin_state,pin_reason,pin_revision::text,pin_after::text,cancel_requested,inflight_action,inflight_source_id::text,
    lease_id::text,lease_until::text
    FROM library.collection_archive_recovery`;
}

async function purgeRecoveryRows(pool: Pool, route: number, accountId: string, uploadId: string) {
  return pool.query(
    `WITH keys AS MATERIALIZED (
       SELECT record_kind,collection_id,source_id FROM library.collection_archive_recovery_record
       WHERE route=$1 AND account_id=$2 AND upload_id=$3
       ORDER BY record_kind,collection_id,source_id LIMIT $4
     )
     DELETE FROM library.collection_archive_recovery_record r USING keys k
     WHERE r.route=$1 AND r.account_id=$2 AND r.upload_id=$3 AND r.record_kind=k.record_kind
       AND r.collection_id=k.collection_id AND r.source_id=k.source_id`,
    [route, accountId, uploadId, cleanupLimit],
  );
}

async function expireRoot(pool: Pool, row: RecoveryRoot) {
  await pool.query(
    `UPDATE library.collection_archive_recovery SET state='expired',source_record_count=0,
       source_membership_complete=false,manifest='{}'::jsonb,coverage='[]'::jsonb,source_pins=NULL,
       upload_digest=repeat('0',64),selected_collection_id=NULL,selected_count=0,review_id=NULL,
       review_key=NULL,review_request_digest=NULL,review_digest=NULL,review_snapshot=NULL,
       native_collection_id=NULL,last_added_member_id=NULL,pin_state='none',pin_reason='evidence_expired',
       pin_revision=NULL,pin_after=NULL,
       cancel_requested=true,inflight_action=NULL,inflight_source_id=NULL,lease_id=NULL,lease_until=NULL
     WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
    [row.route, row.accountId, row.uploadId],
  );
  await purgeRecoveryRows(pool, row.route, row.accountId, row.uploadId);
}

async function expireOwnerEvidence(connection: Pick<PoolClient, 'query'>, route: number, accountId: string, now: string) {
  await connection.query(
    `UPDATE library.collection_archive_recovery SET state='expired',source_record_count=0,
       source_membership_complete=false,manifest='{}'::jsonb,coverage='[]'::jsonb,source_pins=NULL,
       upload_digest=repeat('0',64),selected_collection_id=NULL,selected_count=0,review_id=NULL,
       review_key=NULL,review_request_digest=NULL,review_digest=NULL,review_snapshot=NULL,
       native_collection_id=NULL,last_added_member_id=NULL,pin_state='none',pin_reason='evidence_expired',
       pin_revision=NULL,pin_after=NULL,
       cancel_requested=true,inflight_action=NULL,inflight_source_id=NULL,lease_id=NULL,lease_until=NULL
     WHERE route=$1 AND account_id=$2 AND expires_at<=$3::timestamptz AND state<>'expired'
       AND (lease_id IS NULL OR lease_until<=$3::timestamptz)`,
    [route, accountId, now],
  );
  const removedRecords = await connection.query(
    `WITH keys AS MATERIALIZED (
       SELECT r.upload_id,x.record_kind,x.collection_id,x.source_id
       FROM library.collection_archive_recovery r
       JOIN library.collection_archive_recovery_record x USING(route,account_id,upload_id)
       WHERE r.route=$1 AND r.account_id=$2 AND r.state='expired'
       ORDER BY r.upload_id,x.record_kind,x.collection_id,x.source_id LIMIT $3
     )
     DELETE FROM library.collection_archive_recovery_record x USING keys k
     WHERE x.route=$1 AND x.account_id=$2 AND x.upload_id=k.upload_id
       AND x.record_kind=k.record_kind AND x.collection_id=k.collection_id AND x.source_id=k.source_id`,
    [route, accountId, cleanupLimit],
  );
  await connection.query(
    `WITH keys AS MATERIALIZED (
       SELECT r.upload_id FROM library.collection_archive_recovery r
       WHERE r.route=$1 AND r.account_id=$2 AND r.state='expired'
         AND NOT EXISTS (SELECT 1 FROM library.collection_archive_recovery_record x
           WHERE x.route=r.route AND x.account_id=r.account_id AND x.upload_id=r.upload_id)
       ORDER BY r.upload_id LIMIT $3
     )
     DELETE FROM library.collection_archive_recovery r USING keys k
     WHERE r.route=$1 AND r.account_id=$2 AND r.upload_id=k.upload_id`,
    [route, accountId, Math.max(0, cleanupLimit - (removedRecords.rowCount ?? 0))],
  );
}

function recoveryStatus(root: RecoveryRoot) {
  const expired = root.state === 'expired';
  return {
    uploadId: root.uploadId,
    state: root.state,
    createdAt: expired ? null : root.createdAt,
    expiresAt: root.expiresAt,
    manifest: expired ? null : root.manifest,
    coverage: expired ? [] : root.coverage,
    sourceRecordCount: expired ? 0 : root.sourceRecordCount,
    selectedCollectionId: expired ? null : root.selectedCollectionId,
    selectedOccurrences: expired ? 0 : root.selectedCount,
    collectionId: expired ? null : root.nativeCollectionId,
    cancelRequested: root.cancelRequested,
    confirmation: root.reviewId && root.reviewDigest ? { reviewId: root.reviewId, digest: root.reviewDigest } : null,
    pin: { state: expired ? 'unsupported' : root.pinState, reason: expired ? 'evidence_expired' : root.pinReason },
    sectionReasons,
  };
}

function projectArchive(records: readonly ArchiveRecord[]) {
  const collectionRows = new Map<string, RecoveryRecord>();
  const occurrenceRows: RecoveryRecord[] = [];
  const counts = new Map<string, { members: number; ordered: number }>();
  let membershipComplete = true;
  for (const record of records) {
    if (record.section === 'collections') {
      const id = record.collection_id;
      if (typeof id !== 'string' || !UUID.test(id)) continue;
      collectionRows.set(id, {
        recordKind: 'collection',
        collectionId: id,
        sourceId: id,
        sourceSubjectId: null,
        title: typeof record.title === 'string' ? record.title : null,
        description: record.description === null ? null : typeof record.description === 'string' ? record.description : null,
        metadataValid: validText(record.title, 200, 800, false) &&
          (record.description === null || validText(record.description, 2_000, 8_000, true)),
        visibility: safeString(record.visibility),
        membershipKind: safeString(record.membership_kind),
        builtinKind: safeString(record.builtin_kind),
        presentationKind: safeString(record.presentation_kind),
        memberCount: 0,
        orderedCount: 0,
        orderKey: '',
        orderPresent: false,
        note: null,
        notePresent: false,
        noteValid: true,
      });
    } else if (record.section === 'occurrences') {
      const id = record.member_id;
      if (typeof id !== 'string' || !UUID.test(id)) continue;
      const sourceCollection = typeof record.collection_id === 'string' && UUID.test(record.collection_id)
        ? record.collection_id
        : '';
      if (!sourceCollection || !collectionRows.has(sourceCollection)) membershipComplete = false;
      const order = record.ordinal_key;
      const orderPresent = isOrdinalKey(order);
      const notePresent = Object.hasOwn(record, 'note');
      if (typeof record.note === 'string' && record.note.includes('\0')) throw new ProblemError('invalid_request');
      const note = typeof record.note === 'string' ? record.note : null;
      const noteValid = !notePresent || record.note === null || validText(record.note, 1_000, 4_000, true);
      occurrenceRows.push({
        recordKind: 'occurrence',
        collectionId: sourceCollection || '00000000-0000-0000-0000-000000000000',
        sourceId: id,
        sourceSubjectId: typeof record.subject_id === 'string' ? record.subject_id : null,
        title: null,
        description: null,
        metadataValid: true,
        visibility: null,
        membershipKind: null,
        builtinKind: null,
        presentationKind: null,
        memberCount: 0,
        orderedCount: 0,
        orderKey: orderPresent ? order as string : '',
        orderPresent,
        note,
        notePresent,
        noteValid,
      });
      if (sourceCollection) {
        const count = counts.get(sourceCollection) ?? { members: 0, ordered: 0 };
        count.members++;
        if (orderPresent) count.ordered++;
        counts.set(sourceCollection, count);
      }
    }
  }
  for (const [id, row] of collectionRows) {
    const count = counts.get(id) ?? { members: 0, ordered: 0 };
    row.memberCount = count.members;
    row.orderedCount = count.ordered;
  }
  const values = [...collectionRows.values(), ...occurrenceRows];
  if (values.length > LIBRARY_ARCHIVE_LIMITS.records) throw new ArchiveValidationError('bounds');
  return { values, membershipComplete };
}

function sourcePins(records: readonly ArchiveRecord[]): string[] | null {
  const record = records.find((item) => item.section === 'collectionPins');
  if (!record) return [];
  if (!Array.isArray(record.collection_ids) || record.collection_ids.some((id) => typeof id !== 'string' || !UUID.test(id)))
    return null;
  return record.collection_ids as string[];
}

function storedRecords(values: readonly RecoveryRecord[]) {
  return values.map((record) => ({
    record_kind: record.recordKind,
    collection_id: record.collectionId,
    source_id: record.sourceId,
    source_subject_id: record.sourceSubjectId,
    title: record.title,
    description: record.description,
    metadata_valid: record.metadataValid,
    visibility: record.visibility,
    membership_kind: record.membershipKind,
    builtin_kind: record.builtinKind,
    presentation_kind: record.presentationKind,
    member_count: record.memberCount,
    ordered_count: record.orderedCount,
    order_key: record.orderKey,
    order_present: record.orderPresent,
    note: record.note,
    note_present: record.notePresent,
    note_valid: record.noteValid,
  }));
}

export function createLibraryArchiveCollectionRecovery(deps: RecoveryDependencies) {
  const commands = createCollectionCommands({
    pool: deps.pool,
    access: deps.access,
    clock: deps.clock,
    routeKey: deps.routeKey,
  });
  const pins = () => createPins({ pool: deps.pool, access: deps.access, tokens: deps.tokens, clock: deps.clock });

  async function admit(actor: Actor, scopes: readonly string[] = []) {
    const owner = accountOwner(actor, scopes);
    await admitGroup({
      pool: deps.pool,
      access: () => deps.access,
      actor: owner,
      group: 'collections',
      clientAction: 'collection:read',
      deadline: deadlineFor(10_000),
      clock: deps.clock,
    });
    return owner;
  }

  async function load(owner: Actor, uploadId: string): Promise<RecoveryRoot> {
    const route = routeOf(owner.accountId)!;
    if (!UUID.test(uploadId) || routeOf(uploadId) === null) throw notFound();
    let result = await deps.pool.query<RootRow>(
      `${rootSelect()} WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
      [route, owner.accountId, uploadId],
    );
    const found = result.rows[0];
    if (!found) throw notFound();
    let root = rowValue(found);
    const now = deps.clock().getTime();
    if (Date.parse(root.expiresAt) <= now && root.state !== 'expired' &&
      !(root.leaseUntil && Date.parse(root.leaseUntil) > now)) {
      await expireRoot(deps.pool, root);
      result = await deps.pool.query<RootRow>(
        `${rootSelect()} WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
        [route, owner.accountId, uploadId],
      );
      root = rowValue(result.rows[0]!);
    } else if (root.state === 'expired') {
      await purgeRecoveryRows(deps.pool, route, owner.accountId, uploadId);
    }
    return root;
  }

  async function currentRoot(owner: Actor, uploadId: string, signal?: AbortSignal, scopes: readonly string[] = []) {
    const root = await load(owner, uploadId);
    await admit(owner, scopes);
    abortIfRequested(signal);
    return root;
  }

  async function create(actor: Actor, uploadBase64: string, requestKey: string, signal?: AbortSignal) {
    const owner = await admit(actor);
    abortIfRequested(signal);
    const maxBase64Bytes = Math.ceil(LIBRARY_ARCHIVE_LIMITS.uploadBytes / 3) * 4;
    if (typeof uploadBase64 !== 'string' || uploadBase64.length > maxBase64Bytes ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(uploadBase64))
      throw new ProblemError('invalid_request');
    const bytes = Buffer.from(uploadBase64, 'base64');
    if (bytes.byteLength > LIBRARY_ARCHIVE_LIMITS.uploadBytes || bytes.toString('base64') !== uploadBase64)
      throw new ProblemError('invalid_request');
    const uploadDigest = hash(bytes);
    const route = routeOf(owner.accountId)!;
    const prior = await deps.pool.query<RootRow>(
      `${rootSelect()} WHERE route=$1 AND account_id=$2 AND request_key=$3`,
      [route, owner.accountId, requestKey],
    );
    if (prior.rows[0]) {
      const root = rowValue(prior.rows[0]);
      if (root.uploadDigest !== uploadDigest) throw new ProblemError('idempotency_conflict');
      return recoveryStatus(await currentRoot(owner, root.uploadId, signal));
    }
    let archive;
    try {
      archive = decodeLibraryArchive(bytes);
    } catch (error) {
      if (error instanceof ArchiveValidationError) throw new ProblemError('invalid_request');
      throw error;
    }
    const projected = projectArchive(archive.records);
    const rows = storedRecords(projected.values);
    if (rows.length > LIBRARY_ARCHIVE_LIMITS.records) throw new ProblemError('invalid_request');
    const createdAt = deps.clock().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + lifetime).toISOString();
    const uploadId = newId(route);
    const manifest = archive.manifest;
    const coverage = archive.coverage.map((item) => ({ ...item, reason: sectionReasons[item.section] ?? 'Unsupported archive section.' }));
    const pins = sourcePins(archive.records);
    const jsonRecords = JSON.stringify(rows);
    await admit(owner);
    abortIfRequested(signal);
    await withConnection(deps.pool, async (connection: PoolClient) => {
      await connection.query('BEGIN');
      try {
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`library.archive.recovery:${owner.accountId}`]);
        await expireOwnerEvidence(connection, route, owner.accountId, createdAt);
        const count = await connection.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM library.collection_archive_recovery
           WHERE route=$1 AND account_id=$2`,
          [route, owner.accountId],
        );
        if (Number(count.rows[0]?.count ?? 0) >= LIBRARY_ARCHIVE_RECOVERY_LIMITS.retainedUploadsPerOwner)
          throw new ProblemError('dependency_unavailable');
        await connection.query(
          `INSERT INTO library.collection_archive_recovery
             (route,account_id,upload_id,request_key,upload_digest,manifest,coverage,source_pins,created_at,expires_at,
              state,source_record_count,source_membership_complete)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::timestamptz,$10::timestamptz,'preview',$11,$12)`,
          [
            route,
            owner.accountId,
            uploadId,
            requestKey,
            uploadDigest,
            JSON.stringify(manifest),
            JSON.stringify(coverage),
            pins === null ? null : JSON.stringify(pins),
            createdAt,
            expiresAt,
            rows.length,
            projected.membershipComplete,
          ],
        );
        if (rows.length)
          await connection.query(
            `INSERT INTO library.collection_archive_recovery_record
               (route,account_id,upload_id,record_kind,collection_id,source_id,source_subject_id,title,description,
              visibility,membership_kind,builtin_kind,presentation_kind,member_count,ordered_count,order_key,
                order_present,note,note_present,note_valid,metadata_valid)
             SELECT $1,$2,$3,r.record_kind,r.collection_id,r.source_id,r.source_subject_id,r.title,r.description,
                r.visibility,r.membership_kind,r.builtin_kind,r.presentation_kind,r.member_count,r.ordered_count,
                r.order_key,r.order_present,r.note,r.note_present,r.note_valid,r.metadata_valid
             FROM jsonb_to_recordset($4::jsonb) AS r(
                record_kind text,collection_id text,source_id uuid,source_subject_id text,title text,description text,
                visibility text,membership_kind text,builtin_kind text,presentation_kind text,member_count integer,
                ordered_count integer,order_key text,order_present boolean,note text,note_present boolean,
                note_valid boolean,metadata_valid boolean)`,
            [route, owner.accountId, uploadId, jsonRecords],
          );
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    });
    return recoveryStatus(await currentRoot(owner, uploadId, signal));
  }

  async function status(actor: Actor, uploadId: string, signal?: AbortSignal) {
    const owner = await admit(actor);
    abortIfRequested(signal);
    const current = await currentRoot(owner, uploadId, signal);
    return recoveryStatus(current);
  }

  function collectionCursor(root: RecoveryRoot, collectionId: string, after: readonly unknown[], limit: number) {
    return encodeCursor(
      deps.tokens,
      { operation: 'library_archive_collection.preview', parameters: { accountId: root.accountId, uploadId: root.uploadId, collectionId, limit } },
      { epoch: cursorEpoch(root), after },
      Date.parse(root.createdAt),
    );
  }
  function collectionSeek(root: RecoveryRoot, collectionId: string, token: string, limit: number) {
    const decoded = decodeCursor(
      deps.tokens,
      { operation: 'library_archive_collection.preview', parameters: { accountId: root.accountId, uploadId: root.uploadId, collectionId, limit } },
      token,
      deps.clock().getTime(),
    );
    if (!decoded.ok || decoded.epoch !== cursorEpoch(root) || decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' || typeof decoded.after[1] !== 'string' || !UUID.test(decoded.after[1]))
      throw new ProblemError('invalid_cursor');
    return [decoded.after[0], decoded.after[1]] as const;
  }

  async function listCollections(actor: Actor, uploadId: string, options: { limit?: number; cursor?: string }, signal?: AbortSignal) {
    const owner = await admit(actor);
    abortIfRequested(signal);
    const root = await load(owner, uploadId);
    if (root.state === 'expired') {
      const current = await currentRoot(owner, uploadId, signal);
      return { ...recoveryStatus(current), collections: [], next: null };
    }
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > pageLimit) throw new ProblemError('invalid_request');
    let after = '00000000-0000-0000-0000-000000000000';
    if (options.cursor) {
      const decoded = decodeCursor(
        deps.tokens,
        { operation: 'library_archive_collection.list', parameters: { accountId: owner.accountId, uploadId, limit } },
        options.cursor,
        deps.clock().getTime(),
      );
      if (!decoded.ok || decoded.epoch !== cursorEpoch(root) || decoded.after.length !== 1 ||
        typeof decoded.after[0] !== 'string' || !UUID.test(decoded.after[0])) throw new ProblemError('invalid_cursor');
      after = decoded.after[0];
    }
    const page = await deps.pool.query(
      `SELECT source_id::text AS id,title,description,metadata_valid AS "metadataValid",visibility,membership_kind AS "membershipKind",
         builtin_kind AS "builtinKind",presentation_kind AS "presentationKind",member_count AS "memberCount",
         ordered_count AS "orderedCount"
       FROM library.collection_archive_recovery_record
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='collection' AND source_id>$4::uuid
       ORDER BY source_id LIMIT $5`,
      [root.route, owner.accountId, uploadId, after, limit + 1],
    );
    const hasMore = page.rows.length > limit;
    const collections = page.rows.slice(0, limit).map((row) => ({
      ...row,
        eligible: row.metadataValid && row.membershipKind === 'curated' && row.builtinKind === null,
        metadataValid: row.metadataValid,
      membershipComplete: root.sourceMembershipComplete,
      orderComplete: row.memberCount === row.orderedCount,
      visibilityDisposition: row.visibility === 'public' ? 'will_be_private' : 'private',
      unsupported: row.membershipKind !== 'curated' ? 'dynamic_membership_not_restored' : row.builtinKind ? 'built_in_not_restored' : null,
    }));
    const next = hasMore
      ? encodeCursor(
          deps.tokens,
          { operation: 'library_archive_collection.list', parameters: { accountId: owner.accountId, uploadId, limit } },
          { epoch: cursorEpoch(root), after: [collections.at(-1)!.id] },
          Date.parse(root.createdAt),
        )
      : null;
    const current = await currentRoot(owner, uploadId, signal);
    if (current.state === 'expired') return { ...recoveryStatus(current), collections: [], next: null };
    return { ...recoveryStatus(current), collections, next };
  }

  async function previewCollection(
    actor: Actor,
    uploadId: string,
    collectionId: string,
    options: { limit?: number; cursor?: string },
    signal?: AbortSignal,
  ) {
    const owner = await admit(actor);
    abortIfRequested(signal);
    const root = await load(owner, uploadId);
    if (root.state === 'expired') {
      const current = await currentRoot(owner, uploadId, signal);
      return { ...recoveryStatus(current), collection: null, occurrences: [], next: null };
    }
    if (!UUID.test(collectionId)) throw notFound();
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > pageLimit) throw new ProblemError('invalid_request');
    const collection = await deps.pool.query<{
      id: string; title: string | null; description: string | null; metadataValid: boolean; visibility: string | null;
      membershipKind: string | null; builtinKind: string | null; presentationKind: string | null;
      memberCount: number; orderedCount: number;
    }>(
      `SELECT source_id::text AS id,title,description,metadata_valid AS "metadataValid",visibility,membership_kind AS "membershipKind",
         builtin_kind AS "builtinKind",presentation_kind AS "presentationKind",member_count AS "memberCount",
         ordered_count AS "orderedCount"
       FROM library.collection_archive_recovery_record
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='collection' AND source_id=$4::uuid`,
      [root.route, owner.accountId, uploadId, collectionId],
    );
    const found = collection.rows[0];
    if (!found) throw notFound();
    const after = options.cursor ? collectionSeek(root, collectionId, options.cursor, limit) : ['', '00000000-0000-0000-0000-000000000000'];
    const page = await deps.pool.query(
      `SELECT source_id::text AS "sourceOccurrenceId",source_subject_id AS "sourceSubjectId",note,
         note_present AS "notePresent",note_valid AS "noteValid",order_key AS "orderKey",order_present AS "orderPresent"
       FROM library.collection_archive_recovery_record
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence' AND collection_id=$4
         AND (order_key COLLATE "C",source_id)>($5::text COLLATE "C",$6::uuid)
       ORDER BY order_key COLLATE "C",source_id LIMIT $7`,
      [root.route, owner.accountId, uploadId, collectionId, after[0], after[1], limit + 1],
    );
    const occurrences = page.rows.slice(0, limit).map((row) => ({
      ...row,
      noteState: !row.notePresent ? 'missing' : !row.noteValid ? 'invalid' : row.note === null ? 'cleared' : row.note === '' ? 'empty' : 'value',
      orderState: row.orderPresent ? 'supported' : 'unsupported',
    }));
    const hasMore = page.rows.length > limit;
    const last = occurrences.at(-1);
    const next = hasMore && last
      ? collectionCursor(root, collectionId, [last.orderKey, last.sourceOccurrenceId], limit)
      : null;
    const current = await currentRoot(owner, uploadId, signal);
    if (current.state === 'expired') return { ...recoveryStatus(current), collection: null, occurrences: [], next: null };
    return {
      ...recoveryStatus(current),
      collection: {
        ...found,
        eligible: found.metadataValid && found.membershipKind === 'curated' && found.builtinKind === null,
        metadataValid: found.metadataValid,
        membershipComplete: root.sourceMembershipComplete,
        orderComplete: found.memberCount === found.orderedCount,
        visibilityDisposition: found.visibility === 'public' ? 'will_be_private' : 'private',
        unsupported: found.membershipKind !== 'curated' ? 'dynamic_membership_not_restored' : found.builtinKind ? 'built_in_not_restored' : null,
        presentationDisposition: found.presentationKind === null ? 'none' : 'unsupported_current_meaning',
      },
      occurrences,
      next,
    };
  }

  async function mapTargets(owner: Actor, mappings: ReviewInput['mappings'], signal?: AbortSignal) {
    const results: ReviewMapping[] = [];
    for (const mapping of mappings) {
      abortIfRequested(signal);
      if (mapping.targetSubjectId === null) {
        results.push({ ...mapping, currentSubjectId: null, state: 'unresolved' });
        continue;
      }
      try {
        const resolved = await resolveSubject(
          { pool: deps.pool, access: deps.access, clock: deps.clock },
          owner,
          mapping.targetSubjectId,
        );
        if (!resolved) results.push({ ...mapping, currentSubjectId: null, state: 'unresolved' });
        else if (resolved.subjectId !== mapping.targetSubjectId || resolved.requestedSubjectId !== null)
          results.push({ ...mapping, currentSubjectId: resolved.subjectId, state: 'canonical-changed' });
        else results.push({ ...mapping, currentSubjectId: resolved.subjectId, state: 'mapped' });
      } catch (error) {
        // Inaccessible, retired and missing Subjects have the same non-disclosing review outcome.
        if (!subjectUnavailable(error)) throw error;
        results.push({ ...mapping, currentSubjectId: null, state: 'unresolved' });
      }
    }
    return results;
  }

  async function review(actor: Actor, uploadId: string, input: ReviewInput, requestKey: string, signal?: AbortSignal) {
    const owner = await admit(actor, ['collection:create', 'collection:update']);
    abortIfRequested(signal);
    const root = await load(owner, uploadId);
    if (root.state === 'expired' || root.state === 'cancelled' || root.state === 'complete' || root.state === 'partial')
      throw conflict();
    if (!UUID.test(input.collectionId) || !Array.isArray(input.selectedOccurrenceIds) ||
      input.selectedOccurrenceIds.length > LIBRARY_ARCHIVE_RECOVERY_LIMITS.selectedOccurrences ||
      new Set(input.selectedOccurrenceIds).size !== input.selectedOccurrenceIds.length ||
      input.selectedOccurrenceIds.some((id) => !UUID.test(id)) ||
      !Array.isArray(input.mappings) || input.mappings.length > LIBRARY_ARCHIVE_RECOVERY_LIMITS.selectedOccurrences ||
      new Set(input.mappings.map((item) => item.sourceSubjectId)).size !== input.mappings.length ||
      input.mappings.some((item) => !UUID.test(item.sourceSubjectId) || (item.targetSubjectId !== null && !UUID.test(item.targetSubjectId))))
      throw new ProblemError('invalid_request');
    const requestDigest = digestOf(input);
    if (root.reviewKey === requestKey) {
      if (root.reviewRequestDigest !== requestDigest) throw new ProblemError('idempotency_conflict');
      return reviewResponse(await currentRoot(owner, uploadId, signal, ['collection:create', 'collection:update']));
    }
    if (root.state === 'applying' || root.nativeCollectionId) throw conflict();
    const selected = await deps.pool.query<{
      id: string; subjectId: string | null; note: string | null; notePresent: boolean; noteValid: boolean;
      orderKey: string; orderPresent: boolean;
    }>(
      `SELECT source_id::text AS id,source_subject_id AS "subjectId",note,note_present AS "notePresent",
         note_valid AS "noteValid",
         order_key AS "orderKey",order_present AS "orderPresent"
       FROM library.collection_archive_recovery_record
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
         AND collection_id=$4 AND source_id=ANY($5::uuid[])
       ORDER BY source_id`,
      [root.route, owner.accountId, uploadId, input.collectionId, input.selectedOccurrenceIds],
    );
    if (selected.rows.length !== input.selectedOccurrenceIds.length) throw new ProblemError('invalid_request');
    const collectionResult = await deps.pool.query<{
      id: string; title: string | null; description: string | null; visibility: string | null;
      metadataValid: boolean;
      membershipKind: string | null; builtinKind: string | null; presentationKind: string | null;
      memberCount: number; orderedCount: number;
    }>(
      `SELECT source_id::text AS id,title,description,metadata_valid AS "metadataValid",visibility,membership_kind AS "membershipKind",
         builtin_kind AS "builtinKind",presentation_kind AS "presentationKind",member_count AS "memberCount",
         ordered_count AS "orderedCount"
       FROM library.collection_archive_recovery_record
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='collection' AND source_id=$4::uuid`,
      [root.route, owner.accountId, uploadId, input.collectionId],
    );
    const collection = collectionResult.rows[0];
    if (!collection) throw notFound();
    if (collection.membershipKind !== 'curated' || collection.builtinKind !== null) throw conflict();
    if (!collection.metadataValid || !validText(collection.title, 200, 800, false) ||
      (collection.description !== null && !validText(collection.description, 2_000, 8_000, true)))
      throw new ProblemError('invalid_request');
    const validSubjectIds = [...new Set(selected.rows.flatMap((row) =>
      row.subjectId && UUID.test(row.subjectId) && row.orderPresent ? [row.subjectId] : [],
    ))].sort();
    const requestedMappings = [...input.mappings].sort((a, b) => a.sourceSubjectId < b.sourceSubjectId ? -1 : a.sourceSubjectId > b.sourceSubjectId ? 1 : 0);
    if (requestedMappings.length !== validSubjectIds.length ||
      requestedMappings.some((item, index) => item.sourceSubjectId !== validSubjectIds[index]))
      throw new ProblemError('invalid_request');
    for (const row of selected.rows) {
      if (row.notePresent && (!row.noteValid || (row.note !== null && !validText(row.note, 1_000, 4_000, true))))
        throw new ProblemError('invalid_request');
    }
    const mappings = await mapTargets(owner, requestedMappings, signal);
    const mappingBySource = new Map(mappings.map((mapping) => [mapping.sourceSubjectId, mapping]));
    const reviewId = newId(root.route);
    const reviewEpoch = root.reviewEpoch + 1;
    const operands = selected.rows.map((row) => ({
      memberId: row.id,
      subjectId: row.subjectId,
      targetSubjectId: row.subjectId && mappingBySource.get(row.subjectId)?.state === 'mapped'
        ? mappingBySource.get(row.subjectId)!.currentSubjectId
        : null,
      orderKey: row.orderKey,
      orderPresent: row.orderPresent,
      note: row.note,
      notePresent: row.notePresent,
    }));
    const sourceOrderComplete = selected.rows.every((row) => row.orderPresent);
    const completeMembership = root.sourceMembershipComplete && input.selectedOccurrenceIds.length === collection.memberCount;
    const snapshot: ReviewSnapshot = {
      reviewId,
      reviewEpoch,
      collection: {
        sourceId: input.collectionId,
        title: collection.title,
        description: collection.description,
        memberCount: collection.memberCount,
        visibility: collection.visibility,
        membershipKind: collection.membershipKind,
        presentationKind: collection.presentationKind,
      },
      selectedOccurrenceIds: input.selectedOccurrenceIds,
      mappings,
      operands,
      completeOrder: sourceOrderComplete && collection.memberCount === collection.orderedCount,
      completeMembership,
    };
    const mapped = new Map(mappings.map((mapping) => [mapping.sourceSubjectId, mapping]));
    const occurrenceUpdates = selected.rows.map((row) => {
      const subjectValid = row.subjectId !== null && UUID.test(row.subjectId);
      const mapping = subjectValid ? mapped.get(row.subjectId!) : undefined;
      let addState = 'pending';
      let reason: string | null = row.notePresent ? null : 'missing_note';
      if (!row.orderPresent) { addState = 'unsupported'; reason = 'order_unavailable'; }
      else if (!subjectValid || !mapping || mapping.state !== 'mapped') {
        addState = 'unresolved';
        reason = mapping?.state === 'canonical-changed' ? 'canonical_mapping_changed' : 'subject_unresolved';
      }
      return {
        source_id: row.id,
        target_subject_id: addState === 'pending' ? mapping!.currentSubjectId : null,
        add_state: addState,
        note_state: row.notePresent ? 'pending' : 'unsupported',
        order_state: row.orderPresent ? 'pending' : 'unsupported',
        outcome_reason: reason,
      };
    });
    const pinSectionCaptured = root.coverage.some((value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      (value as { section?: unknown; capture?: unknown }).section === 'collectionPins' &&
      (value as { section?: unknown; capture?: unknown }).capture === 'present',
    );
    const pinsRequested = root.sourcePins?.includes(input.collectionId) ?? false;
    let pinState: RecoveryRoot['pinState'] = 'none';
    let pinRevision: string | null = null;
    let pinAfter: string | null = null;
    let pinReason: string | null = null;
    if (root.sourcePins === null && pinSectionCaptured) {
      pinState = 'unsupported';
      pinReason = 'archive_pin_shape_unavailable';
    } else if (pinsRequested) {
      if (root.sourcePins?.length !== 1) {
        pinState = 'unsupported';
        pinReason = 'other_archived_pins_not_selected';
      } else if (!owner.scopes.includes('library_pin:list') || !owner.scopes.includes('library_pin:update')) {
        pinState = 'unsupported';
        pinReason = 'current_pin_scope_unavailable';
      } else {
        const currentPins = await pins().list(owner, { limit: 100 });
        if (currentPins.pins.length >= 100) {
          pinState = 'unsupported';
          pinReason = 'current_pin_limit';
        } else {
          pinState = 'pending';
          pinRevision = String(currentPins.revision);
          pinAfter = currentPins.pins.at(-1)?.collectionId ?? null;
        }
      }
    }
    const reviewDigest = digestOf({
      ownerId: owner.accountId,
      uploadId,
      snapshot,
      pin: { state: pinState, reason: pinReason, revision: pinRevision, after: pinAfter },
    });
    abortIfRequested(signal);
    await withConnection(deps.pool, async (connection) => {
      await connection.query('BEGIN');
      try {
        const current = await connection.query<{
          state: RecoveryState; review_epoch: string; review_id: string | null;
          review_key: string | null; review_request_digest: string | null;
        }>(
          `SELECT state,review_epoch::text,review_id::text,review_key,review_request_digest
           FROM library.collection_archive_recovery
           WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
          [root.route, owner.accountId, uploadId],
        );
        const latest = current.rows[0];
        if (!latest || latest.state === 'applying' || latest.state === 'cancelled' || latest.state === 'expired') throw conflict();
        if (latest.review_key === requestKey) {
          if (latest.review_request_digest !== requestDigest) throw new ProblemError('idempotency_conflict');
          await connection.query('COMMIT');
          return;
        }
        if (Number(latest.review_epoch) !== root.reviewEpoch) throw conflict();
        if (latest.review_id && latest.review_id === reviewId) throw conflict();
        await connection.query(
          `UPDATE library.collection_archive_recovery_record SET review_id=$4,selected=true,
             target_subject_id=u.target_subject_id,add_state=u.add_state,note_state=u.note_state,
             order_state=u.order_state,outcome_reason=u.outcome_reason,native_member_id=NULL
           FROM jsonb_to_recordset($5::jsonb) AS u(source_id uuid,target_subject_id text,add_state text,
             note_state text,order_state text,outcome_reason text)
           WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
             AND collection_id=$6 AND source_id=u.source_id`,
          [root.route, owner.accountId, uploadId, reviewId, JSON.stringify(occurrenceUpdates), input.collectionId],
        );
        await connection.query(
          `UPDATE library.collection_archive_recovery SET state='reviewed',selected_collection_id=$4::uuid,
             selected_count=$5,review_id=$6::uuid,review_epoch=review_epoch+1,review_key=$7,
             review_request_digest=$8,review_digest=$9,review_snapshot=$10::jsonb,native_collection_id=NULL,
             last_added_member_id=NULL,pin_state=$11,pin_reason=$12,pin_revision=$13::bigint,pin_after=$14::uuid,
             cancel_requested=false
           WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
          [root.route, owner.accountId, uploadId, input.collectionId, input.selectedOccurrenceIds.length,
            reviewId, requestKey, requestDigest, reviewDigest, JSON.stringify(snapshot), pinState,
            pinReason, pinRevision, pinAfter],
        );
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    });
    const reviewed = await currentRoot(owner, uploadId, signal, ['collection:create', 'collection:update']);
    return reviewResponse(reviewed);
  }

  function reviewResponse(root: RecoveryRoot) {
    return {
      ...recoveryStatus(root),
      selectedCollectionId: root.selectedCollectionId,
      review: root.reviewSnapshot ? {
        reviewId: root.reviewSnapshot.reviewId,
        digest: root.reviewDigest,
        epoch: root.reviewSnapshot.reviewEpoch,
        completeOrder: root.reviewSnapshot.completeOrder,
        completeMembership: root.reviewSnapshot.completeMembership,
        selectedOccurrences: root.reviewSnapshot.selectedOccurrenceIds.length,
        mappings: root.reviewSnapshot.mappings.map(({ sourceSubjectId, targetSubjectId, currentSubjectId, state }) =>
          ({ sourceSubjectId, targetSubjectId, currentSubjectId, state })),
      } : null,
      mappings: root.reviewSnapshot?.mappings ?? [],
      completeOrder: root.reviewSnapshot?.completeOrder ?? false,
      completeMembership: root.reviewSnapshot?.completeMembership ?? false,
      pin: { state: root.pinState, reason: root.pinReason, reviewedRevision: root.pinRevision },
    };
  }

  async function invalidateStaleReview(root: RecoveryRoot) {
    await deps.pool.query(
      `UPDATE library.collection_archive_recovery SET state='preview',review_id=NULL,review_key=NULL,
         review_request_digest=NULL,review_digest=NULL,review_snapshot=NULL,native_collection_id=NULL
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='reviewed'`,
      [root.route, root.accountId, root.uploadId],
    );
  }

  async function reviewedMappingsCurrent(owner: Actor, snapshot: ReviewSnapshot, signal?: AbortSignal) {
    for (const mapping of snapshot.mappings) {
      if (mapping.state !== 'mapped' || !mapping.targetSubjectId) continue;
      abortIfRequested(signal);
      try {
        const current = await resolveSubject(
          { pool: deps.pool, access: deps.access, clock: deps.clock },
          owner,
          mapping.targetSubjectId,
        );
        if (!current || current.subjectId !== mapping.targetSubjectId || current.requestedSubjectId !== null) return false;
      } catch (error) {
        if (!subjectUnavailable(error)) throw error;
        return false;
      }
    }
    return true;
  }

  async function acquireLease(root: RecoveryRoot) {
    const leaseId = newId(root.route);
    const now = deps.clock().toISOString();
    const until = new Date(Date.parse(now) + 30_000).toISOString();
    const result = await deps.pool.query<{ lease_id: string | null }>(
      `UPDATE library.collection_archive_recovery SET lease_id=$4::uuid,lease_until=$5::timestamptz,
         state='applying'
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state IN ('reviewed','applying')
         AND (lease_until IS NULL OR lease_until<=$6::timestamptz)
       RETURNING lease_id::text`,
      [root.route, root.accountId, root.uploadId, leaseId, until, now],
    );
    return result.rows[0]?.lease_id ?? null;
  }
  async function releaseLease(root: RecoveryRoot, leaseId: string) {
    await deps.pool.query(
      `UPDATE library.collection_archive_recovery SET lease_id=NULL,lease_until=NULL
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND lease_id=$4::uuid`,
      [root.route, root.accountId, root.uploadId, leaseId],
    );
  }

  async function refreshLease(root: RecoveryRoot, leaseId: string) {
    await deps.pool.query(
      `UPDATE library.collection_archive_recovery SET lease_until=$5::timestamptz
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND lease_id=$4::uuid AND state='applying'`,
      [root.route, root.accountId, root.uploadId, leaseId, new Date(deps.clock().getTime() + 30_000).toISOString()],
    );
  }

  async function beginEffect(
    root: RecoveryRoot,
    leaseId: string,
    action: NonNullable<RecoveryRoot['inflightAction']>,
    sourceId: string | null = null,
  ) {
    const started = await deps.pool.query(
      `UPDATE library.collection_archive_recovery SET inflight_action=$5,inflight_source_id=$6::uuid
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND lease_id=$4::uuid
         AND inflight_action IS NULL AND cancel_requested=false`,
      [root.route, root.accountId, root.uploadId, leaseId, action, sourceId],
    );
    if ((started.rowCount ?? 0) === 1) return true;
    const current = await deps.pool.query<{ inflight_action: RecoveryRoot['inflightAction']; inflight_source_id: string | null }>(
      `SELECT inflight_action,inflight_source_id::text FROM library.collection_archive_recovery
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND lease_id=$4::uuid`,
      [root.route, root.accountId, root.uploadId, leaseId],
    );
    return current.rows[0]?.inflight_action === action && current.rows[0]?.inflight_source_id === sourceId;
  }

  async function checkpointEffect(
    root: RecoveryRoot,
    leaseId: string,
    statement: string,
    values: unknown[],
    second?: { statement: string; values: unknown[] },
  ) {
    await withConnection(deps.pool, async (connection) => {
      await connection.query('BEGIN');
      try {
        await connection.query(statement, values);
        if (second) await connection.query(second.statement, second.values);
        const cleared = await connection.query(
          `UPDATE library.collection_archive_recovery SET inflight_action=NULL,inflight_source_id=NULL
           WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND lease_id=$4::uuid`,
          [root.route, root.accountId, root.uploadId, leaseId],
        );
        if ((cleared.rowCount ?? 0) !== 1) throw conflict();
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function apply(actor: Actor, uploadId: string, confirmation: { reviewId: string; digest: string }, signal?: AbortSignal) {
    const owner = await admit(actor, ['collection:create', 'collection:update']);
    abortIfRequested(signal);
    let root = await load(owner, uploadId);
    if (root.state === 'expired' || root.state === 'cancelled' || root.state === 'partial' || root.state === 'complete')
      return recoveryStatus(await currentRoot(owner, uploadId, signal, ['collection:create', 'collection:update']));
    if (!root.reviewId || root.reviewId !== confirmation.reviewId || root.reviewDigest !== confirmation.digest || !root.reviewSnapshot)
      throw conflict();
    if (root.state === 'reviewed' && !(await reviewedMappingsCurrent(owner, root.reviewSnapshot, signal))) {
      await invalidateStaleReview(root);
      throw conflict();
    }
    const leaseId = await acquireLease(root);
    if (!leaseId)
      return recoveryStatus(await currentRoot(owner, uploadId, signal, ['collection:create', 'collection:update']));
    let commandCount = 0;
    try {
      while (commandCount < applyLimit) {
        abortIfRequested(signal);
        root = await load(owner, uploadId);
        if (root.state === 'cancelled' || root.state === 'expired' || (root.cancelRequested && root.inflightAction === null)) break;
        if (root.reviewId !== confirmation.reviewId || root.reviewDigest !== confirmation.digest || !root.reviewSnapshot)
          throw conflict();
        const snapshot = root.reviewSnapshot;
        if (!root.nativeCollectionId) {
          if (!(await beginEffect(root, leaseId, 'create'))) break;
          const created = await commands.createCollection(
            owner,
            { title: snapshot.collection.title, description: snapshot.collection.description, visibility: 'private' },
            commandKey(root, 'create'),
          );
          await deps.afterNativeEffect?.('create');
          await admit(owner);
          abortIfRequested(signal);
          await checkpointEffect(
            root,
            leaseId,
            `UPDATE library.collection_archive_recovery SET native_collection_id=$4::uuid
             WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND lease_id=$5::uuid`,
            [root.route, owner.accountId, uploadId, created.value.id, leaseId],
          );
          commandCount++;
          await refreshLease(root, leaseId);
          continue;
        }
        const add = await deps.pool.query<{
          source_id: string; target_subject_id: string;
        }>(
          `SELECT source_id::text,target_subject_id
           FROM library.collection_archive_recovery_record
           WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
             AND collection_id=$4 AND review_id=$5::uuid AND selected AND add_state='pending'
           ORDER BY source_id LIMIT 1`,
          [root.route, owner.accountId, uploadId, root.selectedCollectionId, confirmation.reviewId],
        );
        if (add.rows[0]) {
          const item = add.rows[0];
          if (!(await beginEffect(root, leaseId, 'member', item.source_id))) break;
          const prior = await deps.pool.query<{ id: string }>(
            `SELECT native_member_id::text AS id FROM library.collection_archive_recovery_record
             WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
               AND collection_id=$4 AND review_id=$5::uuid AND selected AND add_state='applied'
               AND source_id<$6::uuid ORDER BY source_id DESC LIMIT 1`,
            [root.route, owner.accountId, uploadId, root.selectedCollectionId, confirmation.reviewId, item.source_id],
          );
          let member: Awaited<ReturnType<typeof commands.addMember>>;
          try {
            member = await commands.addMember(
              owner,
              root.nativeCollectionId,
              { subjectId: item.target_subject_id, ...(prior.rows[0] ? { after: prior.rows[0].id } : {}) },
              commandKey(root, 'member', item.source_id),
            );
          } catch (error) {
            const failure = itemFailure(error, 'add');
            if (!failure) throw error;
            await checkpointEffect(
              root,
              leaseId,
              `UPDATE library.collection_archive_recovery_record SET add_state=$7,outcome_reason=$8
               WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
                 AND collection_id=$4 AND source_id=$5::uuid AND review_id=$6::uuid`,
              [root.route, owner.accountId, uploadId, root.selectedCollectionId, item.source_id,
                confirmation.reviewId, failure.state, failure.reason],
            );
            commandCount++;
            await refreshLease(root, leaseId);
            continue;
          }
          await deps.afterNativeEffect?.('member', item.source_id);
          await admit(owner);
          abortIfRequested(signal);
          await checkpointEffect(
            root,
            leaseId,
            `UPDATE library.collection_archive_recovery_record SET native_member_id=$7::uuid,add_state='applied'
             WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
               AND collection_id=$4 AND source_id=$5::uuid AND review_id=$6::uuid`,
            [root.route, owner.accountId, uploadId, root.selectedCollectionId, item.source_id, confirmation.reviewId, member.value.id],
            {
              statement: `UPDATE library.collection_archive_recovery SET last_added_member_id=$4::uuid
                WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND lease_id=$5::uuid`,
              values: [root.route, owner.accountId, uploadId, member.value.id, leaseId],
            },
          );
          commandCount++;
          await refreshLease(root, leaseId);
          continue;
        }
        const note = await deps.pool.query<{
          source_id: string; native_member_id: string; note: string | null; note_present: boolean;
        }>(
          `SELECT source_id::text,native_member_id::text,note,note_present
           FROM library.collection_archive_recovery_record
           WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
             AND collection_id=$4 AND review_id=$5::uuid AND selected AND add_state='applied'
             AND native_member_id IS NOT NULL AND note_state='pending'
           ORDER BY source_id LIMIT 1`,
          [root.route, owner.accountId, uploadId, root.selectedCollectionId, confirmation.reviewId],
        );
        if (note.rows[0]) {
          const item = note.rows[0];
          if (!(await beginEffect(root, leaseId, 'note', item.source_id))) break;
          try {
            await commands.updateMemberNote(
              owner,
              root.nativeCollectionId,
              item.native_member_id,
              { note: item.note },
              commandKey(root, 'note', item.source_id),
            );
          } catch (error) {
            const failure = itemFailure(error, 'note');
            if (!failure) throw error;
            await checkpointEffect(
              root,
              leaseId,
              `UPDATE library.collection_archive_recovery_record SET note_state='failed',outcome_reason=$7
               WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
                 AND collection_id=$4 AND source_id=$5::uuid AND review_id=$6::uuid`,
              [root.route, owner.accountId, uploadId, root.selectedCollectionId, item.source_id,
                confirmation.reviewId, failure.reason],
            );
            commandCount++;
            await refreshLease(root, leaseId);
            continue;
          }
          await deps.afterNativeEffect?.('note', item.source_id);
          await admit(owner);
          abortIfRequested(signal);
          await checkpointEffect(
            root,
            leaseId,
            `UPDATE library.collection_archive_recovery_record SET note_state='applied'
             WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
               AND collection_id=$4 AND source_id=$5::uuid AND review_id=$6::uuid`,
            [root.route, owner.accountId, uploadId, root.selectedCollectionId, item.source_id, confirmation.reviewId],
          );
          commandCount++;
          await refreshLease(root, leaseId);
          continue;
        }
        const order = await deps.pool.query<{
          source_id: string; native_member_id: string; order_key: string;
        }>(
          `SELECT source_id::text,native_member_id::text,order_key
           FROM library.collection_archive_recovery_record
           WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
             AND collection_id=$4 AND review_id=$5::uuid AND selected AND add_state='applied'
             AND native_member_id IS NOT NULL AND order_state='pending'
           ORDER BY order_key COLLATE "C",source_id LIMIT 1`,
          [root.route, owner.accountId, uploadId, root.selectedCollectionId, confirmation.reviewId],
        );
        if (order.rows[0]) {
          const item = order.rows[0];
          if (!(await beginEffect(root, leaseId, 'order', item.source_id))) break;
          const prior = await deps.pool.query<{ id: string }>(
            `SELECT native_member_id::text AS id FROM library.collection_archive_recovery_record
             WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
               AND collection_id=$4 AND review_id=$5::uuid AND selected AND add_state='applied'
               AND native_member_id IS NOT NULL AND order_state='applied'
               AND (order_key COLLATE "C",source_id)<($6::text COLLATE "C",$7::uuid)
             ORDER BY order_key COLLATE "C" DESC,source_id DESC LIMIT 1`,
            [root.route, owner.accountId, uploadId, root.selectedCollectionId, confirmation.reviewId, item.order_key, item.source_id],
          );
          try {
            await commands.moveMember(
              owner,
              root.nativeCollectionId,
              item.native_member_id,
              { after: prior.rows[0]?.id ?? null },
              commandKey(root, 'order', item.source_id),
            );
          } catch (error) {
            const failure = itemFailure(error, 'order');
            if (!failure) throw error;
            await checkpointEffect(
              root,
              leaseId,
              `UPDATE library.collection_archive_recovery_record SET order_state=$7,outcome_reason=$8
               WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
                 AND collection_id=$4 AND source_id=$5::uuid AND review_id=$6::uuid`,
              [root.route, owner.accountId, uploadId, root.selectedCollectionId, item.source_id,
                confirmation.reviewId, failure.state, failure.reason],
            );
            commandCount++;
            await refreshLease(root, leaseId);
            continue;
          }
          await deps.afterNativeEffect?.('order', item.source_id);
          await admit(owner);
          abortIfRequested(signal);
          await checkpointEffect(
            root,
            leaseId,
            `UPDATE library.collection_archive_recovery_record SET order_state='applied'
             WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
               AND collection_id=$4 AND source_id=$5::uuid AND review_id=$6::uuid`,
            [root.route, owner.accountId, uploadId, root.selectedCollectionId, item.source_id, confirmation.reviewId],
          );
          commandCount++;
          await refreshLease(root, leaseId);
          continue;
        }
        root = await load(owner, uploadId);
        if (root.pinState === 'pending') {
          if (!(await beginEffect(root, leaseId, 'pin'))) break;
          let pinApplied = false;
          try {
            await pins().mutate(
              owner,
              root.nativeCollectionId,
              { revision: Number(root.pinRevision), ...(root.pinAfter === null ? { after: null } : { after: root.pinAfter }) },
              commandKey(root, 'pin'),
            );
            pinApplied = true;
          } catch (error) {
            if (!(error instanceof ProblemError && error.code === 'conflict')) throw error;
            await checkpointEffect(
              root,
              leaseId,
              `UPDATE library.collection_archive_recovery SET pin_state='unsupported',pin_reason='current_pin_revision_changed'
               WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND lease_id=$4::uuid`,
              [root.route, owner.accountId, uploadId, leaseId],
            );
          }
          if (pinApplied) {
            await deps.afterNativeEffect?.('pin');
            await admit(owner);
            abortIfRequested(signal);
            await checkpointEffect(
              root,
              leaseId,
              `UPDATE library.collection_archive_recovery SET pin_state='applied'
               WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND lease_id=$4::uuid`,
              [root.route, owner.accountId, uploadId, leaseId],
            );
          }
          commandCount++;
          continue;
        }
        await finish(root, leaseId, confirmation.reviewId);
        break;
      }
    } finally {
      await releaseLease(root, leaseId);
    }
    root = await load(owner, uploadId);
    if (root.state === 'applying' && root.cancelRequested && root.inflightAction === null) {
      await deps.pool.query(
        `UPDATE library.collection_archive_recovery SET state='cancelled'
         WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='applying'
           AND cancel_requested=true AND inflight_action IS NULL`,
        [root.route, owner.accountId, uploadId],
      );
    }
    return recoveryStatus(await currentRoot(owner, uploadId, signal, ['collection:create', 'collection:update']));
  }

  function commandKey(root: RecoveryRoot, action: string, sourceId?: string) {
    return JSON.stringify(['library.collection.archive-recovery', root.uploadId, root.reviewId, action, sourceId ?? null]);
  }

  async function finish(root: RecoveryRoot, leaseId: string, reviewId: string) {
    const totals = await deps.pool.query<{
      all_count: string; selected_count: string; completed_count: string; incomplete_count: string;
    }>(
      `SELECT count(*) FILTER (WHERE selected)::text AS selected_count,
         count(*)::text AS all_count,
         count(*) FILTER (WHERE selected AND add_state='applied' AND note_state='applied' AND order_state='applied')::text AS completed_count,
         count(*) FILTER (WHERE selected AND (add_state<>'applied' OR note_state<>'applied' OR order_state<>'applied'))::text AS incomplete_count
       FROM library.collection_archive_recovery_record
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
         AND collection_id=$4 AND review_id=$5::uuid`,
      [root.route, root.accountId, root.uploadId, root.selectedCollectionId, reviewId],
    );
    const row = totals.rows[0]!;
    const complete = root.sourceMembershipComplete && root.reviewSnapshot?.completeMembership === true &&
      root.reviewSnapshot.completeOrder && Number(row.selected_count) === root.reviewSnapshot.collection.memberCount &&
      Number(row.completed_count) === Number(row.selected_count) && Number(row.incomplete_count) === 0;
    await deps.pool.query(
      `UPDATE library.collection_archive_recovery SET state=$5
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND lease_id=$4::uuid AND state='applying'`,
      [root.route, root.accountId, root.uploadId, leaseId, complete ? 'complete' : 'partial'],
    );
  }

  async function outcomes(actor: Actor, uploadId: string, options: { limit?: number; cursor?: string }, signal?: AbortSignal) {
    const owner = await admit(actor);
    abortIfRequested(signal);
    const root = await load(owner, uploadId);
    if (root.state === 'expired') {
      const current = await currentRoot(owner, uploadId, signal);
      return { ...recoveryStatus(current), collection: null, outcomes: [], next: null };
    }
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > pageLimit) throw new ProblemError('invalid_request');
    if (!root.reviewId || !root.selectedCollectionId) {
      const current = await currentRoot(owner, uploadId, signal);
      return { ...recoveryStatus(current), collection: null, outcomes: [], next: null };
    }
    let after: readonly unknown[] = ['', '00000000-0000-0000-0000-000000000000'];
    if (options.cursor) after = collectionSeek(root, root.selectedCollectionId, options.cursor, limit);
    const page = await deps.pool.query<{
      sourceOccurrenceId: string; sourceSubjectId: string | null; targetSubjectId: string | null;
      nativeMemberId: string | null; note: string | null; notePresent: boolean; noteValid: boolean; orderKey: string;
      orderPresent: boolean; addState: string; noteState: string; orderState: string; outcomeReason: string | null;
    }>(
      `SELECT source_id::text AS "sourceOccurrenceId",source_subject_id AS "sourceSubjectId",
         target_subject_id AS "targetSubjectId",native_member_id::text AS "nativeMemberId",note,
         note_present AS "notePresent",note_valid AS "noteValid",order_key AS "orderKey",order_present AS "orderPresent",
         add_state AS "addState",note_state AS "noteState",order_state AS "orderState",
         outcome_reason AS "outcomeReason"
       FROM library.collection_archive_recovery_record
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND record_kind='occurrence'
         AND collection_id=$4 AND review_id=$5::uuid AND selected
         AND (order_key COLLATE "C",source_id)>($6::text COLLATE "C",$7::uuid)
       ORDER BY order_key COLLATE "C",source_id LIMIT $8`,
      [root.route, owner.accountId, uploadId, root.selectedCollectionId, root.reviewId, after[0], after[1], limit + 1],
    );
    const items = page.rows.slice(0, limit).map((item) => ({
      ...item,
      sourceNoteState: !item.notePresent ? 'missing' : !item.noteValid ? 'invalid' : item.note === null ? 'cleared' : item.note === '' ? 'empty' : 'value',
      outcome: item.addState !== 'applied' ? item.addState : item.noteState !== 'applied' ? 'partial' : item.orderState !== 'applied' ? 'partial' : 'applied',
    }));
    const last = items.at(-1);
    const next = page.rows.length > limit && last
      ? collectionCursor(root, root.selectedCollectionId, [last.orderKey, last.sourceOccurrenceId], limit)
      : null;
    const current = await currentRoot(owner, uploadId, signal);
    if (current.state === 'expired') return { ...recoveryStatus(current), collection: null, outcomes: [], next: null };
    return {
      ...recoveryStatus(current),
      collection: root.nativeCollectionId ? { id: root.nativeCollectionId, visibility: 'private' as const } : null,
      outcomes: items,
      next,
    };
  }

  async function cancel(actor: Actor, uploadId: string, signal?: AbortSignal) {
    const owner = await admit(actor);
    abortIfRequested(signal);
    const root = await load(owner, uploadId);
    if (root.state !== 'expired' && root.state !== 'complete' && root.state !== 'partial')
      await deps.pool.query(
        `UPDATE library.collection_archive_recovery
         SET state=CASE WHEN state='applying' THEN 'applying' ELSE 'cancelled' END,cancel_requested=true
         WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state IN ('preview','reviewed','applying')`,
        [root.route, owner.accountId, uploadId],
      );
    return recoveryStatus(await currentRoot(owner, uploadId, signal));
  }

  return { create, status, listCollections, previewCollection, review, apply, outcomes, cancel };
}
