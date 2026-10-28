import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { checkMediaImportRequest, MediaImportRequestSchema } from '@rezics/definitions/media-import';
import { Value } from 'typebox/value';
import {
  authoritativeTimeValue,
  currentCommand,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { initializeResourceGrants, parentCreationAuthorization } from '../access/index.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { accessCheck, accessCommandAuthorization, type AccessCheck } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { readPartition } from '../partition/partition.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import readThreadTarget from './read-new-thread-target.sql';
import reserveStatement from './reserve-media.sql';
import completeStatement from './complete-media.sql';
import readStatement from './read-media.sql';
import claimStatement from './claim-media.sql';
import { claimCoverMedia } from './cover-reference.ts';
import {
  mediaParentBoard,
  mediaParentChain,
  mediaParentSnapshot,
  prepareRealmParticipation,
  realmParticipationMatches,
  type MediaParent,
  type RealmParticipationProof,
} from './media-parent.ts';
import type { Access, Actor, Resource } from '../request/access.ts';
import type { ImportedSource, Rights } from './imported-contract.ts';
import type { MediaId, PostId, ReadContext, RequestContext, RevisionId, ThreadId } from './model.ts';
import { downloadMedia, type DownloadContext } from './media-download.ts';
import type { RealmParticipationCheck } from '../community/participation.ts';

export type MediaPurpose = 'post-image' | 'cover';
export type MediaState = 'reserved' | 'uploaded' | 'available' | 'rejected';
export type MediaVariant = Readonly<{
  format: 'webp' | 'avif';
  width: number;
  height: number;
  mediaType: string;
  byteCount: number;
  sha256: string;
  key: string;
}>;
type MediaMetadataBase = Readonly<{
  id: MediaId;
  key: string;
  containerId: ThreadId | PostId;
  uploaderId: string;
  route: number;
  reservationRequestId: string;
  declaredSha256?: string;
  sha256: string | null;
  state: MediaState;
  claimedAt: string | null;
  erased: boolean;
  takenDown: boolean;
  securityRevision: string;
  collectionPending: boolean;
  createdAt: string;
  decision: string | null;
  variants: readonly MediaVariant[];
}>;
/** Browser reservations describe post images with measured-size inputs. Imported covers
 * remain unmeasured until the trusted fetch and processing path observes the bytes. */
export type MediaMetadata =
  | (MediaMetadataBase & Readonly<{ purpose: 'post-image'; mediaType: string; byteCount: number }>)
  | (MediaMetadataBase &
      Readonly<{
        purpose: 'cover';
        mediaType: string | null;
        byteCount: number | null;
        rights: Rights;
        source: ImportedSource;
      }>);
type MediaReservationFields = Readonly<{
  purpose: 'post-image';
  mediaType: string;
  byteCount: number;
  sha256?: string;
}>;
export type MediaReservationInput = MediaReservationFields &
  (
    | Readonly<{ containerId: ThreadId | PostId; newThread?: never }>
    | Readonly<{ newThread: Readonly<{ boardId: string; idempotencyKey: string }>; containerId?: never }>
  );
export type NewThreadMediaTarget = Readonly<{ thread: Resource; boardId: string }>;
export type MediaCompletionInput = Readonly<{
  containerId: ThreadId | PostId;
  reservationRequestId: string;
  byteCount: number;
  sha256: string;
}>;
export type MediaDependencies = Readonly<{
  pool: Pool;
  access: Access;
  realmParticipation?: RealmParticipationCheck;
  clock?: () => Date;
  /** Trusted per-request host context; never supplied by request JSON. */
  downloadContext?: DownloadContext;
}>;

export type DownloadVariant = 'original' | `webp-${number}` | `avif-${number}`;
export type DownloadDecision =
  | Readonly<{
      allowed: true;
      key: string;
      sha256: string;
      mediaType: string;
      byteCount: number;
      publicCache: false;
      cacheControl: 'private, no-cache' | 'private, no-store';
    }>
  | Readonly<{ allowed: false }>;
type ClaimMediaBase = Readonly<{
  mediaIds: readonly MediaId[];
  containerId: ThreadId | PostId;
  author: Actor;
  boardId?: string;
}>;
export type ClaimMediaInput = ClaimMediaBase &
  (
    | Readonly<{ itemId: PostId; revisionId: RevisionId; reference?: never }>
    | Readonly<{
        reference: Readonly<{
          kind: 'semantic_candidate';
          subjectId: string;
          candidateId: string;
          revision: number;
        }>;
        itemId?: never;
        revisionId?: never;
      }>
  );
export class NewThreadTargetExistsError extends Error {
  constructor() {
    super('The requested thread already exists');
    this.name = 'NewThreadTargetExistsError';
  }
}
export class InvalidMediaClaimError extends Error {
  constructor() {
    super('The media reference list is invalid');
    this.name = 'InvalidMediaClaimError';
  }
}
export class MediaUnavailableError extends Error {
  constructor() {
    super('The media references cannot be claimed');
    this.name = 'MediaUnavailableError';
  }
}
const imageTypes = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const digestPattern = /^[0-9a-f]{64}(?![\s\S])/;
function account(actor: Actor) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return actor;
}
function route(id: string): number {
  const result = routeOf(id);
  if (result === null) throw new GrantDeniedError();
  return result;
}
function length(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20 * 1024 * 1024)
    throw new TypeError('Invalid media byte count');
}
function digest(value: string): void {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new TypeError('Invalid media SHA256');
}
function requestKey(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255)
    throw new TypeError('Invalid media request identifier');
}
function options(actor: Actor, r: number, kind: string, input: unknown, context: RequestContext) {
  requestKey(context.idempotencyKey);
  const identity = principalCommandIdentity(account(actor));
  return {
    ...identity,
    partition: partitionOf(r),
    deadline: context.deadline,
    receipt: {
      kind,
      key: context.idempotencyKey,
      digest: createHash('sha256')
        .update(canonicalize([identity, kind, input])!)
        .digest(),
    },
  };
}
type Row = Awaited<ReturnType<typeof readStatement.run>>[number];
async function read(client: CommandTransaction, id: string, kind = 'media'): Promise<Row | null> {
  const rows = await readStatement.run(client, { route: route(id), id, kind });
  if (rows.length > 1) throw new GrantDeniedError();
  return rows[0] ?? null;
}

export async function reserveMedia(
  dependencies: MediaDependencies,
  actor: Actor,
  input: MediaReservationInput,
  context: RequestContext,
  newThreadTarget?: NewThreadMediaTarget,
): Promise<CommandOutcome<Readonly<{ mediaId: MediaId }>>> {
  const owner = account(actor);
  const newThread = 'newThread' in input ? input.newThread : undefined;
  if (Boolean(newThread) !== Boolean(newThreadTarget)) throw new TypeError('Invalid new-thread media target');
  if (newThread) {
    requestKey(newThread.idempotencyKey);
    if (newThreadTarget!.boardId !== newThread.boardId) throw new TypeError('Invalid new-thread board');
  }
  const containerId = newThreadTarget?.thread.id ?? ('containerId' in input ? input.containerId : undefined);
  if (!containerId) throw new TypeError('Missing media container');
  const r = route(containerId);
  if (newThreadTarget && newThreadTarget.thread.route !== r) throw new TypeError('Invalid media target route');
  if (input.purpose !== 'post-image' || !imageTypes.has(input.mediaType))
    throw new TypeError('Invalid media purpose or type');
  length(input.byteCount);
  if (input.sha256 !== undefined) digest(input.sha256);
  const body = newThread
    ? {
        newThread: { boardId: newThread.boardId, idempotencyKey: newThread.idempotencyKey },
        purpose: input.purpose,
        mediaType: input.mediaType,
        byteCount: input.byteCount,
        ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      }
    : {
        containerId,
        purpose: input.purpose,
        mediaType: input.mediaType,
        byteCount: input.byteCount,
        ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      };
  const mediaId = newId(r);
  const resource = { route: r, id: mediaId };
  let insertedTransaction: string | undefined;
  let preparedChain: MediaParent[] = [];
  let disclosure: (AccessCheck | null)[] = [];
  let boardRealmId: string | null = null;
  const participation = new WeakMap<AuthoritativeTime, RealmParticipationProof>();
  let boardRead: AccessCheck | undefined;
  let threadCreate: AccessCheck | undefined;
  const board = newThreadTarget ? { route: route(newThreadTarget.boardId), id: newThreadTarget.boardId } : undefined;
  const base = parentCreationAuthorization({
    access: dependencies.access,
    actor,
    action: 'media:create',
    parent: {
      resource: board ?? { route: r, id: containerId },
      async validate(client, time) {
        if (board) {
          const partition = await readPartition(client, partitionOf(board.route));
          if (!partition || partition.writeState === 'moved') return false;
          const current = await mediaParentBoard(client, board.id);
          if (dependencies.realmParticipation && !realmParticipationMatches(participation.get(time), current.realm_id))
            throw new GrantDeniedError();
          if (current.visibility !== 'published' && !(await boardRead!(client, time))) return false;
          return threadCreate!(client, time);
        }
        const current = await mediaParentChain(client, containerId);
        if (current.length !== preparedChain.length) return false;
        for (let i = 0; i < current.length; i++) {
          const row = current[i]!;
          const before = preparedChain[i]!;
          if (
            row.id !== before.id ||
            row.kind !== before.kind ||
            row.visibility !== before.visibility ||
            row.security_revision !== before.security_revision ||
            row.thread_id !== before.thread_id ||
            row.parent_id !== before.parent_id ||
            row.board_id !== before.board_id
          )
            return false;
          const check = disclosure[i];
          if (check && !(await check(client, time))) return false;
        }
        // The board lives on its own anchor and is read only in prepare; a parent
        // checkout on the container's partition never reads it.
        if (dependencies.realmParticipation && !realmParticipationMatches(participation.get(time), boardRealmId))
          throw new GrantDeniedError();
        return true;
      },
    },
    context: {
      pool: dependencies.pool,
      deadline: context.deadline,
      resource,
      creation: {
        async validate(tx, target, time) {
          const row = await read(tx, target.id);
          return (
            row !== null &&
            row.inserted_here === true &&
            row.transaction_id === insertedTransaction &&
            row.uploader_id === owner.accountId &&
            row.container_id === containerId &&
            row.reservation_request_id === context.idempotencyKey &&
            Date.parse(row.created_at!) === Date.parse(authoritativeTimeValue(time))
          );
        },
      },
    },
  });
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      if (board) {
        boardRead = await accessCheck(dependencies.access, actor, 'board:read', board, {
          pool: dependencies.pool,
          deadline: context.deadline,
        });
        threadCreate = await accessCheck(dependencies.access, actor, 'thread:create', board, {
          pool: dependencies.pool,
          deadline: context.deadline,
        });
        if (dependencies.realmParticipation) {
          const current = await mediaParentSnapshot(dependencies.pool, board.route, context.deadline, (client) =>
            mediaParentBoard(client, board.id),
          );
          const proof = await prepareRealmParticipation(
            dependencies.pool,
            dependencies.realmParticipation,
            actor,
            current.realm_id,
            attempt.time,
            context.deadline,
          );
          if (!proof.allowed) throw new GrantDeniedError();
          participation.set(attempt.time, proof);
        }
        return base.prepare!(attempt);
      }
      // Prepare private-ancestor formula evidence before the parent checkout.
      // Every retry resolves the bounded chain again; no resource connection is retained.
      preparedChain = await mediaParentSnapshot(dependencies.pool, r, context.deadline, (client) =>
        mediaParentChain(client, containerId),
      );
      disclosure = [];
      for (const row of preparedChain) {
        disclosure.push(
          row.visibility === 'published'
            ? null
            : await accessCheck(
                dependencies.access,
                actor,
                `${row.kind}:read`,
                { route: route(row.id), id: row.id },
                { pool: dependencies.pool, deadline: context.deadline },
              ),
        );
      }
      const boardId = preparedChain.at(-1)!.board_id!;
      // Prepare independently, then read the board and apply the existing formula
      // on its own native anchor. Public visibility needs no private read grant.
      const containerBoardRead = await accessCheck(
        dependencies.access,
        actor,
        'board:read',
        { route: route(boardId), id: boardId },
        { pool: dependencies.pool, deadline: context.deadline },
      );
      await mediaParentSnapshot(dependencies.pool, route(boardId), context.deadline, async (client) => {
        const board = await mediaParentBoard(client, boardId);
        boardRealmId = board.realm_id;
        if (board.visibility !== 'published' && !(await containerBoardRead(client, attempt.time)))
          throw new GrantDeniedError();
      });
      if (dependencies.realmParticipation) {
        const proof = await prepareRealmParticipation(
          dependencies.pool,
          dependencies.realmParticipation,
          actor,
          boardRealmId,
          attempt.time,
          context.deadline,
        );
        if (!proof.allowed) throw new GrantDeniedError();
        participation.set(attempt.time, proof);
      }
      // Release the board checkout before parent-at-T authorization and the new
      // media-only write/initializer. These independent anchors are not atomic.
      return base.prepare!(attempt);
    },
    async authorize(tx, attempt, evidence) {
      const mode = await base.authorize(tx, attempt, evidence);
      if (newThreadTarget) {
        const target = await readThreadTarget.run(tx, { route: r, id: containerId });
        if (target) throw new NewThreadTargetExistsError();
      }
      return mode;
    },
  };
  return runCommand(
    dependencies.pool,
    { ...options(actor, r, 'content.media.reserve', body, context), clock: dependencies.clock, authorization },
    async (tx, command) => {
      await reserveStatement.run(tx, {
        route: r,
        media_id: mediaId,
        container_id: containerId,
        uploader_id: owner.accountId,
        reservation_request_id: context.idempotencyKey,
        purpose: body.purpose,
        media_type: body.mediaType,
        byte_count: body.byteCount,
        declared_sha256: body.sha256 ?? null,
        key: `m/${mediaId}/original`,
        at: authoritativeTimeValue(command.time),
        transaction_id: command.transactionId,
      });
      insertedTransaction = command.transactionId;
      await initializeResourceGrants(tx, { resource, type: 'content.media', creator: owner.accountId });
      return {
        value: { mediaId },
        events: [
          {
            type: 'com.rezics.content.media.reserved.v1',
            subject: mediaId,
            data: { mediaId, containerId, actorId: owner.accountId },
          },
        ],
      };
    },
  );
}
export async function completeMedia(
  dependencies: MediaDependencies,
  actor: Actor,
  mediaId: MediaId,
  input: MediaCompletionInput,
  context: RequestContext,
): Promise<CommandOutcome<Readonly<{ mediaId: MediaId; state: 'uploaded' }>>> {
  const owner = account(actor);
  const r = route(mediaId);
  if (owner.clientId !== 'rezics-website' || route(input.containerId) !== r) throw new GrantDeniedError();
  length(input.byteCount);
  digest(input.sha256);
  requestKey(input.reservationRequestId);
  const body = {
    containerId: input.containerId,
    reservationRequestId: input.reservationRequestId,
    byteCount: input.byteCount,
    sha256: input.sha256,
  };
  // Scope and current owner-role/grant authority are evaluated by the ONE Access formula.
  const base = await accessCommandAuthorization(
    dependencies.access,
    actor,
    'media:complete',
    { route: r, id: mediaId },
    { pool: dependencies.pool, deadline: context.deadline },
    () => new GrantDeniedError(),
  );
  const authorization: CommandAuthorization = {
    ...base,
    async authorize(tx, attempt, evidence) {
      const mode = await base.authorize(tx, attempt, evidence);
      const row = await read(tx, mediaId);
      if (
        !row ||
        row.purpose !== 'post-image' ||
        row.uploader_id !== owner.accountId ||
        row.container_id !== body.containerId ||
        row.reservation_request_id !== body.reservationRequestId ||
        Number(row.byte_count) !== body.byteCount ||
        (row.declared_sha256 !== null && row.declared_sha256 !== body.sha256) ||
        row.erased ||
        row.taken_down ||
        row.collection_pending
      )
        throw new GrantDeniedError();
      return mode;
    },
  };
  return runCommand(
    dependencies.pool,
    {
      ...options(actor, r, 'content.media.complete', [mediaId, body], context),
      clock: dependencies.clock,
      authorization,
    },
    async (tx, command) => {
      const rows = await completeStatement.run(tx, {
        route: r,
        media_id: mediaId,
        uploader_id: owner.accountId,
        container_id: body.containerId,
        reservation_request_id: body.reservationRequestId,
        byte_count: body.byteCount,
        sha256: body.sha256,
        transaction_id: command.transactionId,
      });
      if (rows.length !== 1) throw new GrantDeniedError();
      return {
        value: { mediaId, state: 'uploaded' as const },
        events: [
          {
            type: 'com.rezics.content.media.uploaded.v1',
            subject: mediaId,
            data: { mediaId, containerId: body.containerId, actorId: owner.accountId },
          },
        ],
      };
    },
  );
}
export async function readReservation(
  dependencies: MediaDependencies,
  mediaId: MediaId,
  context: ReadContext,
): Promise<MediaMetadata | null> {
  if (context.actor.kind !== 'account' || routeOf(mediaId) === null || Date.now() >= context.deadline) return null;
  const check = await accessCheck(
    dependencies.access,
    context.actor,
    'media:read_reservation',
    { route: route(mediaId), id: mediaId },
    { pool: dependencies.pool, deadline: context.deadline },
  );
  if (!(await check(dependencies.pool))) return null;
  const row = await read(dependencies.pool, mediaId);
  if (
    !row ||
    row.uploader_id !== context.actor.accountId ||
    row.container_id === null ||
    row.key === null ||
    row.reservation_request_id === null ||
    row.state === null ||
    row.erased === null ||
    row.taken_down === null ||
    row.media_security_revision === null ||
    row.collection_pending === null ||
    row.created_at === null ||
    Date.now() >= context.deadline
  )
    return null;
  const variants: unknown = JSON.parse(row.variants_json);
  if (!Array.isArray(variants) || !variants.every(isVariant)) return null;
  const metadata: MediaMetadataBase = {
    id: mediaId,
    route: route(mediaId),
    containerId: row.container_id,
    uploaderId: row.uploader_id,
    key: row.key,
    reservationRequestId: row.reservation_request_id,
    ...(row.declared_sha256 === null ? {} : { declaredSha256: row.declared_sha256 }),
    sha256: row.sha256,
    state: row.state,
    claimedAt: row.claimed_at,
    erased: row.erased,
    takenDown: row.taken_down,
    securityRevision: row.media_security_revision,
    collectionPending: row.collection_pending,
    createdAt: row.created_at,
    decision: row.decision,
    variants,
  };
  if (row.purpose === 'post-image' && row.media_type !== null && row.byte_count !== null)
    return { ...metadata, purpose: row.purpose, mediaType: row.media_type, byteCount: Number(row.byte_count) };
  if (row.purpose !== 'cover') return null;
  const source = {
    containerId: row.container_id,
    sourceUrl: row.source_url,
    credit: row.credit,
    provenance: row.provenance,
  };
  if (!Value.Check(MediaImportRequestSchema, source) || checkMediaImportRequest(source).length > 0) return null;
  return {
    ...metadata,
    purpose: 'cover',
    mediaType: row.media_type,
    byteCount: row.byte_count === null ? null : Number(row.byte_count),
    rights: {
      license: source.credit.license,
      obligations: source.credit.obligations,
      attribution: `(c) ${source.credit.rightsHolder}; via [${source.credit.via.name}](${source.credit.via.url})`,
    },
    source: source.provenance,
  };
}
function isVariant(value: unknown): value is MediaVariant {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'format' in value &&
    (value.format === 'webp' || value.format === 'avif') &&
    'width' in value &&
    typeof value.width === 'number' &&
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    'height' in value &&
    typeof value.height === 'number' &&
    Number.isSafeInteger(value.height) &&
    value.height > 0 &&
    'mediaType' in value &&
    value.mediaType === `image/${value.format}` &&
    'byteCount' in value &&
    typeof value.byteCount === 'number' &&
    Number.isSafeInteger(value.byteCount) &&
    value.byteCount > 0 &&
    'sha256' in value &&
    typeof value.sha256 === 'string' &&
    digestPattern.test(value.sha256) &&
    'key' in value &&
    typeof value.key === 'string'
  );
}
export async function claimMedia(transaction: CommandTransaction, input: ClaimMediaInput): Promise<void> {
  const command = currentCommand(transaction);
  const owner = account(input.author);
  const r = route(input.containerId);
  if (new Set(input.mediaIds).size !== input.mediaIds.length) throw new InvalidMediaClaimError();
  if (
    command.partition !== partitionOf(r) ||
    command.basis?.actorAccountId !== owner.accountId ||
    command.basis.clientId !== owner.clientId ||
    command.basis.requestedBy !== owner.requestedBy ||
    command.authorization?.mode !== 'execute' ||
    (command.authorization.action !== 'thread:create' && command.authorization.resource.route !== r) ||
    input.mediaIds.length > 32
  )
    throw new GrantDeniedError();
  if (input.reference?.kind === 'semantic_candidate') {
    if (
      input.itemId !== undefined ||
      input.revisionId !== undefined ||
      input.reference.subjectId !== input.containerId ||
      routeOf(input.reference.subjectId) !== r ||
      routeOf(input.reference.candidateId) !== r ||
      command.authorization.resource.id !== input.containerId
    )
      throw new GrantDeniedError();
    await claimCoverMedia(transaction, input);
    return;
  }
  if (
    input.reference !== undefined ||
    (command.authorization.action !== 'thread:create' &&
      command.authorization.action !== 'post:create' &&
      command.authorization.action !== 'post:revise') ||
    (command.authorization.action === 'thread:create' &&
      (input.boardId === undefined ||
        command.authorization.resource.id !== input.boardId ||
        routeOf(input.boardId) !== command.authorization.resource.route)) ||
    (command.authorization.action !== 'thread:create' && input.boardId !== undefined) ||
    (command.authorization.action === 'post:revise' && command.authorization.resource.id !== input.itemId) ||
    routeOf(input.itemId) !== r ||
    routeOf(input.revisionId) !== r
  )
    throw new GrantDeniedError();
  const ids = [...new Set(input.mediaIds)];
  if (ids.some((id) => routeOf(id) !== r)) throw new MediaUnavailableError();
  if (ids.length === 0) return;
  const rows = await claimStatement.run(transaction, {
    route: r,
    media_ids: ids,
    container_id: input.containerId,
    uploader_id: owner.accountId,
    item_id: input.itemId,
    revision_id: input.revisionId,
    authorization_resource_id:
      command.authorization.action === 'thread:create' ? input.boardId! : command.authorization.resource.id,
    new_thread: command.authorization.action === 'thread:create',
    at: authoritativeTimeValue(command.time),
  });
  if (rows.length !== ids.length) throw new MediaUnavailableError();
}
export function decideDownload(
  dependencies: MediaDependencies,
  mediaId: MediaId,
  actor: Actor,
  variant: DownloadVariant,
): Promise<DownloadDecision> {
  return downloadMedia(
    dependencies,
    mediaId,
    actor,
    variant,
    dependencies.downloadContext ?? { deadline: deadlineFor(2000) },
  );
}
export async function readMediaState(pool: Pool, mediaId: MediaId): Promise<MediaState | null> {
  if (routeOf(mediaId) === null) return null;
  return (await read(pool, mediaId))?.state ?? null;
}
export async function readCollectionFence(pool: Pool, mediaId: MediaId): Promise<boolean | null> {
  if (routeOf(mediaId) === null) return null;
  return (await read(pool, mediaId))?.collection_pending ?? null;
}
export type { MediaStorage } from './media-storage.ts';
