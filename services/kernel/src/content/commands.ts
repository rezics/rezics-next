import { createHash, createHmac } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  createResourceCreationManifest,
  initializeResourceGrants,
  parentCreationAuthorization,
  resourceAuthorization,
  type ResourceCreationEntry,
  type ResourceCreationPort,
} from '../access/index.ts';
import defaults from '../access/resource-roles.json';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { accessCheck, type Access, type AccessClient, type Actor, type Resource } from '../request/access.ts';
import { prepareRealmParticipationResult, type RealmParticipationCheck } from '../community/participation.ts';
import membershipHistory from '../community/membership-history.sql';
import { readPartition } from '../partition/partition.ts';
import { withConnection } from '../database/pool.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../route/route.ts';
import { InvalidDocumentError, validateContentDocument } from './document.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { claimMedia, InvalidMediaClaimError, MediaUnavailableError } from './media.ts';
import {
  mediaParentBoard,
  mediaParentSnapshot,
  realmParticipationMatches,
  type RealmParticipationProof,
} from './media-parent.ts';
import type {
  ContentCommandValue,
  PostInput,
  RequestContext,
  RevisionInput,
  ReviewVoteCitation,
  ThreadInput,
} from './model.ts';
import readBoard from './read-board.sql';
import readThread from './read-thread.sql';
import readPost from './read-post.sql';
import insertThread from './create-thread.sql';
import insertPost from './create-post.sql';
import insertRevision from './create-revision.sql';
import updateHead from './update-head.sql';
import readReviewVote from './read-review-vote.sql';

export type { ReviewVoteCitation } from './model.ts';

export { DocumentTooLargeError, InvalidDocumentError } from './document.ts';
export type ContentCommandDependencies = Readonly<{
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  realmParticipation?: RealmParticipationCheck;
  clock?: () => Date;
}>;
export type ThreadTarget = Resource;
type ThreadCreationInput = ThreadInput & Readonly<{ mediaIds?: readonly string[] }>;
const CREATE_THREAD = 'content.thread.create';
const CREATE_POST = 'content.post.create';
const REVISE_POST = 'content.post.revise';
const CONTENT_GRANT_TYPES = ['content.thread', 'content.post'] as const;

/** Role resolution drops a content template when any named action is unmounted.
 * Thread and post creation still have to install the canonical owner and standing
 * grants; the definitions live in the shared role document. */
function ensureContentGrantTemplates(access: Access): void {
  const installed = resourceRoleCatalogue(access);
  if (!installed || CONTENT_GRANT_TYPES.every((type) => installed.types.has(type))) return;
  const roles = new Map(installed.roles);
  const types = new Map(installed.types);
  const roleActions = defaults.roles as Readonly<Record<string, readonly string[]>>;
  const typeTemplates = defaults.types as Readonly<
    Record<string, { readonly owner?: string; readonly standing: readonly string[] }>
  >;
  for (const type of CONTENT_GRANT_TYPES) {
    if (types.has(type)) continue;
    const template = typeTemplates[type];
    if (!template) continue;
    const roleNames = [...(template.owner === undefined ? [] : [template.owner]), ...template.standing];
    for (const role of roleNames) {
      const actions = roleActions[role];
      if (!roles.has(role) && actions) roles.set(role, actions);
    }
    if (!roleNames.every((role) => roles.has(role))) continue;
    types.set(type, {
      ...(template.owner === undefined ? {} : { owner: template.owner }),
      standing: [...template.standing],
    });
  }
  installResourceRoleCatalogue(access, { roles, types });
}

export class ContentNotFoundError extends Error {
  constructor() {
    super('Content not found');
    this.name = 'ContentNotFoundError';
  }
}
export class ContentUndisclosedError extends ContentNotFoundError {
  constructor() {
    super();
    this.name = 'ContentUndisclosedError';
  }
}
export class ContentForbiddenError extends Error {
  constructor() {
    super('Content write is not authorized');
    this.name = 'ContentForbiddenError';
  }
}
export class RevisionPreconditionError extends Error {
  constructor() {
    super('Revision precondition failed');
    this.name = 'RevisionPreconditionError';
  }
}
export class ReviewConflictError extends Error {
  constructor() {
    super('The author already has a live review of this subject on the board');
    this.name = 'ReviewConflictError';
  }
}
function account(actor: Actor) {
  if (actor.kind !== 'account') throw new ContentForbiddenError();
  return actor;
}
function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new ContentNotFoundError();
  return value;
}
function reviewCitation(value: unknown): ReviewVoteCitation | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidDocumentError();
  const citation = value as Record<string, unknown>;
  if (
    Object.keys(citation).length !== 3 ||
    Object.keys(citation).some((key) => !['questionId', 'units', 'revision'].includes(key)) ||
    typeof citation.questionId !== 'string' ||
    routeOf(citation.questionId) === null ||
    !Number.isSafeInteger(citation.units) ||
    (citation.units as number) < 0 ||
    (citation.units as number) > 20 ||
    !Number.isSafeInteger(citation.revision) ||
    (citation.revision as number) < 1
  )
    throw new InvalidDocumentError();
  return {
    questionId: citation.questionId,
    units: citation.units as number,
    revision: citation.revision as number,
  };
}
async function currentReviewCitation(
  tx: CommandTransaction,
  authorId: string,
  subjectId: string,
  value: unknown,
): Promise<ReviewVoteCitation | null> {
  const citation = reviewCitation(value);
  if (!citation) return null;
  const row = await readReviewVote.run(tx, {
    route: route(authorId),
    voter_id: authorId,
    question_id: citation.questionId,
    target_id: subjectId,
  });
  if (!row || row.units === null || Number(row.units) !== citation.units || Number(row.revision) !== citation.revision)
    throw new InvalidDocumentError('Vote citation does not match the author’s current vote');
  return citation;
}
function postgresConstraint(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'constraint' in error && typeof error.constraint === 'string'
    ? error.constraint
    : undefined;
}
export function threadTarget(routeKey: Uint8Array, accountId: string, idempotencyKey: string): Resource {
  return threadTargetAtRoute(routeKey, accountId, idempotencyKey);
}
function threadTargetAtRoute(
  routeKey: Uint8Array,
  accountId: string,
  idempotencyKey: string,
  routeOverride?: number,
): Resource {
  const identity = `${accountId}\n${CREATE_THREAD}\n${idempotencyKey}`;
  const r = routeOverride ?? anchorRoute(routeKey, identity);
  const bytes = createHmac('sha256', routeKey).update(`content.thread.target.id\n${identity}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  bytes[10] = r >>> 8;
  bytes[11] = r & 0xff;
  const hex = bytes.toString('hex');
  return {
    route: r,
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}
function options(
  dependencies: ContentCommandDependencies,
  actor: Actor,
  r: number,
  kind: string,
  input: unknown,
  context: RequestContext,
) {
  const identity = principalCommandIdentity(account(actor));
  return {
    ...identity,
    partition: partitionOf(r),
    deadline: context.deadline,
    clock: dependencies.clock,
    receipt: {
      kind,
      key: context.idempotencyKey,
      digest: createHash('sha256')
        .update(canonicalize([identity, kind, input])!)
        .digest(),
    },
  };
}
// Snapshot the request before the first await; semantic document validation belongs
// after authorization and receipt lookup, inside the body phase.
function request<T>(input: T): T {
  return JSON.parse(canonicalize(input)!) as T;
}
type ThreadRow = NonNullable<Awaited<ReturnType<typeof readThread.run>>>;
type PostRow = NonNullable<Awaited<ReturnType<typeof readPost.run>>>;
type Chain = { thread: ThreadRow; posts: PostRow[] };
async function thread(client: AccessClient, id: string): Promise<ThreadRow> {
  const row = await readThread.run(client, { route: route(id), id });
  if (!row || row.availability !== 'available' || row.visibility === 'taken_down') throw new ContentNotFoundError();
  return row;
}
function erasedRow(row: PostRow): boolean {
  return row.availability === 'erased' || row.revision_availability === 'erased';
}
async function post(client: AccessClient, id: string, threadId: string, allowErased = false): Promise<PostRow> {
  if (route(id) !== route(threadId)) throw new ContentNotFoundError();
  const row = await readPost.run(client, { route: route(id), id });
  if (!row || row.thread_id !== threadId || row.visibility === 'taken_down') throw new ContentNotFoundError();
  // The row already carries availability. Authorization may observe an erased
  // chain; a fresh command refuses it in the body before any write.
  if (
    !(allowErased && erasedRow(row)) &&
    (row.availability !== 'available' || row.revision_availability !== 'available')
  )
    throw new ContentNotFoundError();
  return row;
}
async function chain(client: AccessClient, threadId: string, itemId: string | null, limit: number): Promise<Chain> {
  const root = await thread(client, threadId);
  const posts: PostRow[] = [];
  const seen = new Set<string>();
  let id = itemId;
  while (id !== null) {
    if (seen.has(id) || posts.length >= limit) throw new ContentNotFoundError();
    seen.add(id);
    posts.push(await post(client, id, threadId, true));
    id = posts.at(-1)!.reply_to_post_id;
  }
  return { thread: root, posts };
}
function sameChain(left: Chain, right: Chain): boolean {
  // Only identity/containment/security participate: a concurrent ordinary edit
  // does not turn an authorized receipt replay into a different operation.
  const signature = (value: Chain) =>
    JSON.stringify([
      value.thread.thread_id,
      value.thread.board_id,
      value.thread.visibility,
      value.thread.security_revision,
      value.thread.availability,
      value.posts.map((row) => [
        row.post_id,
        row.thread_id,
        row.reply_to_post_id,
        row.author_account_id,
        row.visibility,
        row.security_revision,
        row.availability,
        row.revision_availability,
      ]),
    ]);
  return signature(left) === signature(right);
}
function mediaReferences(value: unknown, r: number): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new InvalidMediaClaimError();
  const ids: string[] = [];
  for (const id of value as unknown[]) {
    if (typeof id !== 'string') throw new InvalidMediaClaimError();
    if (routeOf(id) !== r) throw new MediaUnavailableError();
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) throw new InvalidMediaClaimError();
  return ids;
}
function document(body: unknown, licence: string, subjectIds: readonly (string | null)[]) {
  if (!Array.isArray(subjectIds) || subjectIds.length > 128)
    throw new InvalidDocumentError('Too many subject references');
  return validateContentDocument({ body, licence, subjectIds });
}

function storedSubjectIds(values: readonly (string | null)[]): string[] {
  if (values.some((value) => typeof value !== 'string')) throw new TypeError('Stored subject references are invalid');
  return values as string[];
}

async function prepareContentParticipation(
  dependencies: ContentCommandDependencies,
  actor: Actor,
  realmId: string | null,
  time: AuthoritativeTime,
  deadline: number,
  concealDepartedMember = false,
): Promise<RealmParticipationProof> {
  const proof = await prepareRealmParticipationResult(
    dependencies.pool,
    dependencies.realmParticipation,
    actor,
    realmId,
    time,
    deadline,
  );
  if (proof.readable === false) {
    if (concealDepartedMember && actor.kind === 'account' && realmId !== null) {
      const route = routeOf(realmId);
      if (route !== null) {
        const history = await withConnection(dependencies.pool, (client) =>
          membershipHistory.run(client, { route, realm_id: realmId, account_id: actor.accountId }),
        );
        if (history?.hadMembership) throw new ContentUndisclosedError();
      }
    }
    throw new ContentNotFoundError();
  }
  return proof;
}

/** Private read checks compose Access. No grant rows or ownership policy are
 * interpreted by content, and no connection is held during evidence preparation. */
function containerAuthorization(
  dependencies: ContentCommandDependencies,
  actor: Actor,
  threadId: string,
  itemId: string | null,
  context: RequestContext,
  revising: boolean,
  concealDepartedMember = false,
) {
  const r = route(threadId);
  const resource = { route: r, id: revising ? itemId! : threadId };
  let prepared: Chain;
  let current: Chain;
  let checks: Awaited<ReturnType<typeof accessCheck>>[] = [];
  const participation = new WeakMap<AuthoritativeTime, RealmParticipationProof>();
  let currentPlaceId = GLOBAL_CONTEXT;
  const limit = revising ? 33 : 32;
  // A non-author never held a revise receipt. Keep today's not_found ahead of
  // the authorship denial. The author's fresh key is refused in the body so an
  // exact replay can pass authorization and return its receipt.
  function concealErasedRevise(value: Chain): void {
    if (!revising || !value.posts.some((row) => erasedRow(row))) return;
    if (value.posts[0]?.author_account_id !== account(actor).accountId) throw new ContentNotFoundError();
  }
  async function validate(client: AccessClient, time: AuthoritativeTime) {
    current = await chain(client, threadId, itemId, limit);
    if (!sameChain(prepared, current)) throw new ContentNotFoundError();
    concealErasedRevise(current);
    const board = await mediaParentBoard(client, current.thread.board_id);
    currentPlaceId = board.realm_id ?? GLOBAL_CONTEXT;
    if (dependencies.realmParticipation && !realmParticipationMatches(participation.get(time), board.realm_id))
      throw new ContentForbiddenError();
    if (revising && current.posts[0]?.author_account_id !== account(actor).accountId) throw new ContentForbiddenError();
    for (const check of checks) if (!(await check(client, time))) throw new ContentNotFoundError();
    return true;
  }
  return {
    resource,
    validate,
    get current() {
      return current;
    },
    get placeId() {
      return currentPlaceId;
    },
    wrap(base: CommandAuthorization): CommandAuthorization {
      return {
        ...base,
        async prepare(attempt) {
          prepared = await mediaParentSnapshot(dependencies.pool, r, context.deadline, (client) =>
            chain(client, threadId, itemId, limit),
          );
          concealErasedRevise(prepared);
          if (revising && prepared.posts[0]?.author_account_id !== account(actor).accountId)
            throw new ContentForbiddenError();
          checks = [];
          const nodes = [
            { id: threadId, kind: 'thread', visibility: prepared.thread.visibility },
            ...prepared.posts.map((row) => ({ id: row.post_id, kind: 'post', visibility: row.visibility })),
          ];
          for (const node of nodes) {
            if (node.visibility !== 'published')
              checks.push(
                await accessCheck(
                  dependencies.access,
                  actor,
                  `${node.kind}:read`,
                  { route: r, id: node.id },
                  { pool: dependencies.pool, deadline: context.deadline },
                ),
              );
          }
          const boardId = prepared.thread.board_id;
          const boardCheck = await accessCheck(
            dependencies.access,
            actor,
            'board:read',
            { route: route(boardId), id: boardId },
            { pool: dependencies.pool, deadline: context.deadline },
          );
          await mediaParentSnapshot(dependencies.pool, route(boardId), context.deadline, async (client) => {
            const board = await readBoard.run(client, { route: route(boardId), id: boardId });
            if (
              !board ||
              board.visibility === 'taken_down' ||
              (board.visibility !== 'published' && !(await boardCheck(client, attempt.time)))
            )
              throw new ContentNotFoundError();
          });
          if (dependencies.realmParticipation) {
            const board = await mediaParentSnapshot(dependencies.pool, route(boardId), context.deadline, (client) =>
              mediaParentBoard(client, boardId),
            );
            const proof = await prepareContentParticipation(
              dependencies,
              actor,
              board.realm_id,
              attempt.time,
              context.deadline,
              concealDepartedMember,
            );
            if (!proof.allowed) throw new ContentForbiddenError();
            participation.set(attempt.time, proof);
          }
          try {
            return await base.prepare!(attempt);
          } catch (error) {
            // Erasure used to fail closed before the creation grant. A fresh reply
            // from a persona without post:create stays not_found and writes nothing.
            // An authorized replay still reaches its receipt.
            if (!revising && prepared.posts.some((row) => erasedRow(row)) && error instanceof GrantDeniedError)
              throw new ContentNotFoundError();
            throw error;
          }
        },
        async authorize(tx, attempt, evidence) {
          const mode = await base.authorize(tx, attempt, evidence);
          // Recheck the sole mutation partition in its serializable transaction,
          // before the receipt seam, including for replay.
          await validate(tx, attempt.time);
          return mode;
        },
      };
    },
  };
}

/** Each declaration proves a unique INSERT, exact provenance and trusted T on
 * this transaction. An existing resource cannot acquire fresh creation rights. */
function creationEntries(
  actor: Actor,
  resources: readonly { resource: Resource; type: 'content.thread' | 'content.post' }[],
  inserted: WeakMap<CommandTransaction, string>,
): ResourceCreationEntry[] {
  return resources.map(({ resource, type }) => ({
    resource,
    type,
    creator: account(actor).accountId,
    creation: {
      async validate(tx, target, time) {
        const row =
          type === 'content.thread'
            ? await readThread.run(tx, { route: target.route, id: target.id })
            : await readPost.run(tx, { route: target.route, id: target.id });
        return (
          row !== null &&
          row.inserted_here === true &&
          inserted.get(tx) !== undefined &&
          row.recorded_transaction_id === inserted.get(tx) &&
          row.author_account_id === account(actor).accountId &&
          typeof row.created_at === 'string' &&
          Date.parse(row.created_at) === Date.parse(authoritativeTimeValue(time))
        );
      },
    } satisfies ResourceCreationPort,
  }));
}
async function appendRevision(
  tx: CommandTransaction,
  value: ContentCommandValue,
  body: unknown,
  licence: string,
  subjectIds: readonly (string | null)[],
  boardId: string,
  mediaIds: readonly string[],
  transactionId: string,
  time: AuthoritativeTime,
  voteCitation: ReviewVoteCitation | null = null,
) {
  const validated = document(body, licence, subjectIds);
  await insertRevision.run(tx, {
    route: route(value.threadId),
    thread_id: value.threadId,
    post_id: value.itemId,
    revision_id: value.revisionId,
    body: Buffer.from(validated.canonicalBytes),
    body_sha256: Buffer.from(validated.sha256, 'hex'),
    search_text: validated.searchText,
    licence: validated.licence,
    subject_ids: validated.subjectIds,
    board_id: boardId,
    media_ids: [...mediaIds],
    vote_citation: voteCitation,
    transaction_id: transactionId,
    at: authoritativeTimeValue(time),
  });
  return validated.subjectIds;
}
const CREATED_EVENT = {
  thread: 'com.rezics.content.thread.created.v1',
  post: 'com.rezics.content.post.created.v1',
  revision: 'com.rezics.content.revision.created.v1',
} as const;

type ThreadIndexEventFields = Readonly<{
  placeId: string;
  kind: 'discussion' | 'review';
  subjectIds: readonly string[];
  activityAt: string;
  previousSubjectIds?: readonly string[];
}>;

function eventActivityAt(time: AuthoritativeTime): string {
  const authoritative = authoritativeTimeValue(time);
  const value = new Date(authoritative);
  if (!Number.isFinite(value.getTime())) throw new TypeError('Invalid authoritative content time');
  const fraction = /\.(\d+)(?=(?:Z|[+-]\d\d(?::?\d\d)?)$)/.exec(authoritative)?.[1] ?? '';
  const microseconds = `${fraction}000000`.slice(0, 6);
  return value.toISOString().replace(/\.\d{3}Z$/, `.${microseconds}Z`);
}

function result<Noun extends keyof typeof CREATED_EVENT>(
  value: ContentCommandValue,
  actor: Actor,
  noun: Noun,
  index: ThreadIndexEventFields,
) {
  return {
    value,
    events: [
      {
        type: CREATED_EVENT[noun],
        subject: value.itemId,
        data: { ...value, actorId: account(actor).accountId, ...index },
      },
    ],
  };
}

export async function createThread(
  dependencies: ContentCommandDependencies,
  actor: Actor,
  input: ThreadCreationInput,
  context: RequestContext,
): Promise<CommandOutcome<ContentCommandValue>> {
  ensureContentGrantTemplates(dependencies.access);
  const author = account(actor);
  const body = request(input);
  const board = { route: route(body.boardId), id: body.boardId };
  const threadKind = body.kind ?? 'discussion';
  const target = threadTargetAtRoute(
    dependencies.routeKey,
    author.accountId,
    context.idempotencyKey,
    threadKind === 'review' ? route(author.accountId) : undefined,
  );
  const postTarget = { route: target.route, id: newId(target.route) };
  const value = { threadId: target.id, itemId: postTarget.id, revisionId: newId(target.route) };
  const inserted = new WeakMap<CommandTransaction, string>();
  const entries = creationEntries(
    actor,
    [
      { resource: target, type: 'content.thread' },
      { resource: postTarget, type: 'content.post' },
    ],
    inserted,
  );
  let boardCheck: Awaited<ReturnType<typeof accessCheck>>;
  let threadPlaceId = GLOBAL_CONTEXT;
  const participation = new WeakMap<AuthoritativeTime, RealmParticipationProof>();
  const base = parentCreationAuthorization({
    access: dependencies.access,
    actor,
    action: 'thread:create',
    parent: {
      resource: board,
      async validate(client, time) {
        const partition = await readPartition(client, partitionOf(board.route));
        if (!partition || partition.writeState === 'moved') throw new ContentNotFoundError();
        const row = await readBoard.run(client, { route: board.route, id: board.id });
        if (
          !row ||
          row.visibility === 'taken_down' ||
          (row.visibility !== 'published' && !(await boardCheck(client, time)))
        )
          throw new ContentNotFoundError();
        const current = await mediaParentBoard(client, board.id);
        threadPlaceId = current.realm_id ?? GLOBAL_CONTEXT;
        // board_identity makes purpose immutable, so this validation cannot race a purpose change.
        if ((current.purpose === 'reviews') !== (threadKind === 'review')) throw new InvalidDocumentError();
        if (dependencies.realmParticipation && !realmParticipationMatches(participation.get(time), current.realm_id))
          throw new ContentForbiddenError();
        return true;
      },
    },
    context: {
      pool: dependencies.pool,
      deadline: context.deadline,
      resource: target,
      creation: entries[0]!.creation,
      manifest: createResourceCreationManifest(entries),
    },
  });
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      boardCheck = await accessCheck(dependencies.access, actor, 'board:read', board, {
        pool: dependencies.pool,
        deadline: context.deadline,
      });
      if (dependencies.realmParticipation) {
        const current = await mediaParentSnapshot(dependencies.pool, board.route, context.deadline, async (client) => {
          try {
            return await mediaParentBoard(client, board.id);
          } catch (error) {
            if (error instanceof GrantDeniedError) throw new ContentNotFoundError();
            throw error;
          }
        });
        const proof = await prepareContentParticipation(
          dependencies,
          actor,
          current.realm_id,
          attempt.time,
          context.deadline,
        );
        if (!proof.allowed) throw new ContentForbiddenError();
        participation.set(attempt.time, proof);
      }
      return base.prepare!(attempt);
    },
  };
  try {
    return await runCommand(
      dependencies.pool,
      { ...options(dependencies, actor, target.route, CREATE_THREAD, body, context), authorization },
      async (tx, command) => {
        if (
          typeof body.title !== 'string' ||
          body.title.trim().length === 0 ||
          (body.visibility !== 'published' && body.visibility !== 'draft') ||
          (threadKind !== 'discussion' && threadKind !== 'review')
        )
          throw new InvalidDocumentError();
        const isReview = threadKind === 'review';
        if (isReview && (body.subjectIds.length !== 1 || routeOf(body.subjectIds[0]!) === null))
          throw new InvalidDocumentError('A review must name exactly one subject');
        if (!isReview && body.voteCitation !== undefined) throw new InvalidDocumentError();
        const citation = isReview
          ? await currentReviewCitation(tx, author.accountId, body.subjectIds[0]!, body.voteCitation)
          : null;
        const mediaIds = mediaReferences(body.mediaIds === undefined ? [] : body.mediaIds, target.route);
        const at = authoritativeTimeValue(command.time);
        await insertThread.run(tx, {
          route: target.route,
          thread_id: value.threadId,
          author_id: author.accountId,
          board_id: body.boardId,
          kind: threadKind,
          review_subject_id: isReview ? body.subjectIds[0]! : null,
          title: body.title,
          visibility: body.visibility,
          transaction_id: command.transactionId,
          first_post_id: value.itemId,
          at,
        });
        await insertPost.run(tx, {
          route: target.route,
          thread_id: value.threadId,
          post_id: value.itemId,
          parent_id: null,
          author_id: author.accountId,
          revision_id: value.revisionId,
          visibility: body.visibility,
          transaction_id: command.transactionId,
          at,
        });
        const subjectIds = await appendRevision(
          tx,
          value,
          body.body,
          body.licence,
          body.subjectIds,
          body.boardId,
          mediaIds,
          command.transactionId,
          command.time,
          citation,
        );
        inserted.set(tx, command.transactionId);
        for (const entry of entries) await initializeResourceGrants(tx, entry);
        if (mediaIds.length)
          await claimMedia(tx, {
            mediaIds,
            containerId: value.threadId,
            author,
            itemId: value.itemId,
            revisionId: value.revisionId,
            boardId: body.boardId,
          });
        return result(value, actor, 'thread', {
          placeId: threadPlaceId,
          kind: threadKind,
          subjectIds,
          activityAt: eventActivityAt(command.time),
        });
      },
    );
  } catch (error) {
    if (postgresConstraint(error) === 'thread_one_live_review_idx') throw new ReviewConflictError();
    throw error;
  }
}

export async function createPost(
  dependencies: ContentCommandDependencies,
  actor: Actor,
  input: PostInput,
  context: RequestContext,
): Promise<CommandOutcome<ContentCommandValue>> {
  ensureContentGrantTemplates(dependencies.access);
  const author = account(actor);
  const body = request(input);
  const r = route(body.threadId);
  const target = { route: r, id: newId(r) };
  const value = { threadId: body.threadId, itemId: target.id, revisionId: newId(r) };
  const container = containerAuthorization(
    dependencies,
    actor,
    body.threadId,
    body.parentId ?? null,
    context,
    false,
    true,
  );
  const inserted = new WeakMap<CommandTransaction, string>();
  const entries = creationEntries(actor, [{ resource: target, type: 'content.post' }], inserted);
  const authorization = container.wrap(
    parentCreationAuthorization({
      access: dependencies.access,
      actor,
      action: 'post:create',
      parent: { resource: container.resource, validate: container.validate },
      context: {
        pool: dependencies.pool,
        deadline: context.deadline,
        resource: target,
        creation: entries[0]!.creation,
        manifest: createResourceCreationManifest(entries),
      },
    }),
  );
  return runCommand(
    dependencies.pool,
    { ...options(dependencies, actor, r, CREATE_POST, body, context), authorization },
    async (tx, command) => {
      if (container.current.posts.some((row) => erasedRow(row))) throw new ContentNotFoundError();
      const root = container.current.thread;
      if (body.boardId !== undefined && body.boardId !== root.board_id)
        throw new InvalidDocumentError('Board mismatch');
      const firstPost = await post(tx, root.first_post_id!, body.threadId);
      const mediaIds = mediaReferences(body.mediaIds === undefined ? [] : body.mediaIds, r);
      await insertPost.run(tx, {
        route: r,
        thread_id: value.threadId,
        post_id: value.itemId,
        parent_id: body.parentId ?? null,
        author_id: author.accountId,
        revision_id: value.revisionId,
        visibility: 'published',
        transaction_id: command.transactionId,
        at: authoritativeTimeValue(command.time),
      });
      await appendRevision(
        tx,
        value,
        body.body,
        body.licence,
        body.subjectIds === undefined ? firstPost.subject_ids : body.subjectIds,
        root.board_id,
        mediaIds,
        command.transactionId,
        command.time,
      );
      inserted.set(tx, command.transactionId);
      await initializeResourceGrants(tx, entries[0]!);
      if (mediaIds.length)
        await claimMedia(tx, {
          mediaIds,
          containerId: body.threadId,
          author,
          itemId: value.itemId,
          revisionId: value.revisionId,
        });
      return result(value, actor, 'post', {
        placeId: container.placeId,
        kind: container.current.thread.kind,
        subjectIds: storedSubjectIds(firstPost.subject_ids),
        activityAt: eventActivityAt(command.time),
      });
    },
  );
}

export async function revisePost(
  dependencies: ContentCommandDependencies,
  actor: Actor,
  input: RevisionInput,
  context: RequestContext,
): Promise<CommandOutcome<ContentCommandValue>> {
  const author = account(actor);
  const body = request({ ...input, expectedRevisionId: input.expectedRevisionId ?? null });
  const r = route(body.threadId);
  const value = { threadId: body.threadId, itemId: body.itemId, revisionId: newId(r) };
  const container = containerAuthorization(dependencies, actor, body.threadId, body.itemId, context, true);
  const authorization = container.wrap(
    resourceAuthorization({
      access: dependencies.access,
      actor,
      action: 'post:revise',
      anchor: { resource: container.resource, validate: container.validate },
      context: { pool: dependencies.pool, deadline: context.deadline, partition: partitionOf(r) },
    }),
  );
  return runCommand(
    dependencies.pool,
    { ...options(dependencies, actor, r, REVISE_POST, body, context), authorization },
    async (tx, command) => {
      const previous = container.current.posts[0]!;
      // A fresh key cannot revise an erased post or any erased ancestor. Replay
      // never enters this body. updateHead also refuses to advance an erased head.
      if (container.current.posts.some((row) => erasedRow(row))) throw new ContentNotFoundError();
      if (body.expectedRevisionId !== null && body.expectedRevisionId !== previous.head_revision_id)
        throw new RevisionPreconditionError();
      if (body.boardId !== undefined && body.boardId !== container.current.thread.board_id)
        throw new InvalidDocumentError('Board mismatch');
      const mediaIds = mediaReferences(body.mediaIds === undefined ? previous.media_ids : body.mediaIds, r);
      const isFirstPost = value.itemId === container.current.thread.first_post_id;
      const citation = reviewCitation(body.voteCitation);
      if (citation && (container.current.thread.kind !== 'review' || !isFirstPost)) throw new InvalidDocumentError();
      const revisedSubjectIdsInput = body.subjectIds === undefined ? previous.subject_ids : body.subjectIds;
      if (
        container.current.thread.kind === 'review' &&
        isFirstPost &&
        (revisedSubjectIdsInput.length !== 1 ||
          revisedSubjectIdsInput[0] !== container.current.thread.review_subject_id)
      )
        throw new InvalidDocumentError('A review must retain exactly its target subject');
      const currentCitation = citation
        ? await currentReviewCitation(tx, author.accountId, container.current.thread.review_subject_id!, citation)
        : null;
      const revisedSubjectIds = await appendRevision(
        tx,
        value,
        body.body,
        body.licence === undefined ? previous.licence : body.licence,
        body.subjectIds === undefined ? previous.subject_ids : body.subjectIds,
        body.boardId === undefined ? previous.board_id : body.boardId,
        mediaIds,
        command.transactionId,
        command.time,
        currentCitation,
      );
      const changed = await updateHead.run(tx, {
        route: r,
        thread_id: value.threadId,
        post_id: value.itemId,
        author_id: author.accountId,
        revision_id: value.revisionId,
        previous_revision_id: previous.head_revision_id,
      });
      if (!changed) throw new ContentNotFoundError();
      if (mediaIds.length)
        await claimMedia(tx, {
          mediaIds,
          containerId: body.threadId,
          author,
          itemId: value.itemId,
          revisionId: value.revisionId,
        });
      const indexSubjectIds = isFirstPost
        ? revisedSubjectIds
        : storedSubjectIds((await post(tx, container.current.thread.first_post_id!, value.threadId)).subject_ids);
      return result(value, actor, 'revision', {
        placeId: container.placeId,
        kind: container.current.thread.kind,
        subjectIds: indexSubjectIds,
        activityAt: eventActivityAt(command.time),
        ...(isFirstPost ? { previousSubjectIds: storedSubjectIds(previous.subject_ids) } : {}),
      });
    },
  );
}
