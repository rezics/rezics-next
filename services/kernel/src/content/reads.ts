import { ProblemError } from '../http/problem.ts';
import { readVisibleRatingQuestion } from '../rating/question-directory.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { createHash } from 'node:crypto';
import {
  bindRealmSubjectReadWork,
  realmSubjectBegin,
  realmSubjectCommit,
  realmSubjectPartition,
  realmSubjectContentPoint,
  realmSubjectReadRoot,
  type RealmSubjectReadContext,
} from './realm-subject-disclosure-work.ts';
import { parseStoredDocument, serializeDocument } from '@rezics/document';
import { isSpdxLicense } from './document.ts';
import presentationRuleBodies from './community-presentation-rules.sql';
import { readCommunityPresentations } from './community-presentation.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import { commandAccessContext } from '../access/command-admission.ts';
import { accountStandingCheck } from '../access/index.ts';
import { spaceReadEligibility } from '../community/space.ts';
import { authoritativeTimeValue } from '../command/command.ts';
import { realmReadEligibility } from '../community/realm.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { createReadEligibilityWork } from './read-eligibility-access-work.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import type { AccessContext } from '../request/access.ts';
import type { ContentEditionSource } from './edition-model.ts';
import { prepareEditionSubject, type EditionSourceAuthorization } from './edition-subject.ts';
import {
  DurableInitiatorUnavailableError,
  type DurableOperationAnchor,
  type InitiatorRestorer,
} from '../access/durable-initiator.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition, readPartitions, type Partition } from '../partition/partition.ts';
import {
  accessExplicitCheck,
  accessCheck,
  type Access,
  type AccessCheck,
  type AccessClient,
  type Actor,
  type ReadDecisions,
  type Resource,
} from '../request/access.ts';
import { prepareReadDecisions } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { isErasedPlaceholder } from './model.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import readThreadPlace from './read-thread-place.sql';
import currentBan from '../community/ban-current.sql';
import type {
  Anchored,
  AnchoredPosition,
  BoardId,
  BoardRecord as BoardView,
  ErasedPlaceholder,
  ItemView as StoredItemView,
  Page,
  PostId,
  ReadContext,
  RevisionId,
  RevisionView as StoredRevisionView,
  ReviewVoteCitation,
  ThreadId,
  ThreadView as StoredThreadView,
  Visibility,
} from './model.ts';
import { REACTION_KINDS } from './events.ts';
import { pagePostCandidates } from './post-pages.ts';
import { pageRevisionCandidates } from './revision-pages.ts';
import read from './read-chain.sql';
import pageCounts from './reaction-count-page.sql';
import viewerReactions from './reaction-viewer.sql';
import pageSubjectReactionCounts from './subject-reaction-count-page.sql';
import readBoardBatch from './read-board-batch.sql';
import readChainBatch from './read-chain-batch.sql';
import readPostBatch from './read-post-batch.sql';
import readRevisionBatch from './read-revision-batch.sql';
import readRealmBatch from './read-realm-batch.sql';
import banCurrentManyBatch from './ban-current-many-batch.sql';
import matchThreadTextBatch from './match-thread-text-batch.sql';

const reactionKinds: ReadonlySet<string> = new Set(REACTION_KINDS);
const subjectReactionKinds = ['like', 'love', 'laugh', 'insightful', 'sad'] as const;
/** The receipt revision for the command response currently being disclosed. */
const replayedRevision = new AsyncLocalStorage<string>();
export type RealmDisclosureScope = {
  realmId?: string | null;
  realmResource?: Resource;
  realmEvidence?: unknown;
  realmEvidencePrepared?: boolean;
  associationCheck?: Promise<boolean>;
  accessCheck?: Promise<boolean>;
};
const realmDisclosure = new AsyncLocalStorage<RealmDisclosureScope>();
const threadReadAdmission = new AsyncLocalStorage<() => Promise<void>>();

/** Server-owned work between initial and final disclosure, without changing the published reader port. */
export function withThreadReadAdmission<T>(beforeFinal: () => Promise<void>, read: () => Promise<T>): Promise<T> {
  return threadReadAdmission.run(beforeFinal, read);
}

/** Share one containing-Realm proof across the thread and post checks in a disclosure. */
export function currentRealmDisclosureScope(): RealmDisclosureScope | undefined {
  return realmDisclosure.getStore();
}

function withRealmDisclosureScope<T>(read: () => Promise<T>): Promise<T> {
  if (realmDisclosure.getStore()) return read();
  return realmDisclosure.run({}, read);
}

/** One exact command replay. GET reads stay outside this scope, so owner roles
 * and the public floor still cannot authorize erased metadata. */
export function withReplayedRevision<T>(revisionId: string, read: () => Promise<T>): Promise<T> {
  return replayedRevision.run(revisionId, read);
}
export type ViewerReactionKind = (typeof REACTION_KINDS)[number];

/** Erased slots retain identity without disclosing bytes or a digest of erased text. */
type AvailablePayload = Readonly<{
  availability: 'available';
  body: NonNullable<StoredItemView['body']>;
  sha256: string;
}>;
type ErasedPayload = Readonly<{
  availability: 'erased';
  removed: true;
  body: null;
  sha256: null;
  restorableUntil?: string;
}>;
type ContentPayload = AvailablePayload | ErasedPayload;
type WithheldPayload = Readonly<{
  availability: 'withheld';
  removed: true;
  body: null;
  sha256: null;
  decisionId?: string;
}>;
type ItemFields = Omit<StoredItemView, 'availability' | 'body' | 'sha256'>;
export type ItemView = ItemFields & ContentPayload;
export type WithheldPostEntry = ItemFields & WithheldPayload;
export type RevisionView = Omit<StoredRevisionView, 'availability' | 'body' | 'sha256'> & ContentPayload;
export type PostEntry = ItemView | (ErasedPlaceholder & { readonly restorableUntil?: string }) | WithheldPostEntry;
export type ThreadView = Omit<StoredThreadView, 'firstPost'> & Readonly<{ firstPost: PostEntry }>;

export type ContentReadDependencies = Readonly<{ pool: Pool; access: Access; tokens: KeyRing; clock?: () => Date }>;
export type NativeDraftMetadata = Readonly<{
  id: string;
  threadId: string;
  firstPostId: string;
  revisionId: string;
  authorId: string;
  kind: 'discussion' | 'review';
  documentKind: 'opening' | 'reply';
  title: string | null;
  savedAt: string;
  licence: string;
  subjectIds: readonly string[];
  mediaIds: readonly string[];
  board: { id: string; title: string | null; realmId: string | null };
}>;
export type { Actor };

type Kind = 'board' | 'thread' | 'post' | 'revision';
type Row = {
  kind: Kind;
  id: string;
  thread_id: string | null;
  board_id: string | null;
  parent_id: string | null;
  author_id: string | null;
  head_id: string | null;
  first_post_id: string | null;
  thread_kind: 'discussion' | 'review' | null;
  board_purpose: 'discussion' | 'reviews' | null;
  vote_citation: ReviewVoteCitation | null;
  title: string | null;
  visibility: Visibility;
  security_revision: string;
  availability: 'available' | 'erased';
  created_at: Date;
  revised_at: Date | null;
  licence: string;
  subject_ids: string[];
  media_ids: string[];
  body: Buffer | null;
  sha256: Buffer | null;
  realm_id: string | null;
  deleted_at: Date | null;
  restorable: boolean;
  decision_id: string | null;
  matches?: boolean | null;
};
type Chain = { thread: Row; posts: Row[]; revision: Row | null };
type Key = { at: string; id: string };

export class ContentNotFoundError extends Error {
  constructor() {
    super('Content not found');
    this.name = 'ContentNotFoundError';
  }
}

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Invalid content identity');
  return value;
}

/** All pool preparation happens outside this boundary. A failed rollback evicts
 * the connection rather than returning an open transaction to the pool. */
export async function snapshot<T>(
  dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>,
  id: string,
  context: Pick<RealmSubjectReadContext, 'deadline' | 'work'>,
  work: (client: AccessClient) => Promise<T>,
): Promise<Anchored<T>> {
  return within(context.deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      bindRealmSubjectReadWork(client, context.work);
      let began = false;
      try {
        await realmSubjectBegin(client, () => {
          began = true;
        });
        const partitionNo = partitionOf(route(id));
        const partition = context.work
          ? await realmSubjectPartition(client, partitionNo)
          : await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        const value = await work(client);
        await realmSubjectCommit(client);
        return { value, anchor: { partition, epoch: partition.epoch, position: partition.position } };
      } catch (error) {
        // Admission failure dispatched no BEGIN and reserved no cleanup slot.
        if (!began) throw error;
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

type BatchKey = { route: number; id: string; thread_id: string };
type RealmBatchRow = {
  route: number;
  realm_id: string;
  state: string;
  visibility: 'public' | 'protected';
  head_revision_id: string;
  created_at: Date;
  revision_created_at: Date;
};
type BanKey = { route: number; realm_id: string; account_ids: string[] };

type BoardDisclosureFinal = Readonly<{ boardAnchor: AnchoredPosition; parentAllowed: boolean }>;
type BoardDisclosureHint = Readonly<{
  boardId: BoardId;
  board: BoardView;
  decisions?: ReadDecisions;
  query?: string;
  expectedRevisions?: ReadonlyMap<string, string>;
  onFinal?: (final: BoardDisclosureFinal) => void;
}>;
const boardDisclosureHint = new AsyncLocalStorage<BoardDisclosureHint>();

export function withBoardDisclosure<T>(
  boardId: BoardId,
  board: BoardView,
  work: () => Promise<T>,
  decisions?: ReadDecisions,
  options: Pick<BoardDisclosureHint, 'query' | 'expectedRevisions' | 'onFinal'> = {},
): Promise<T> {
  return boardDisclosureHint.run({ boardId, board, ...(decisions ? { decisions } : {}), ...options }, work);
}

function batchKey(id: string, threadId = id): BatchKey {
  return { route: route(id), id, thread_id: threadId };
}

async function batchRows(
  client: AccessClient,
  kind: Kind,
  keys: readonly BatchKey[],
  includeBody = false,
  query = '',
): Promise<Row[]> {
  if (keys.length === 0) return [];
  const statement = {
    board: readBoardBatch,
    thread: readChainBatch,
    post: readPostBatch,
    revision: readRevisionBatch,
  }[kind];
  const parameters = {
    keys: JSON.stringify(keys),
    include_body: includeBody,
    query,
  };
  const result = await client.query<Row>(
    statement.sql,
    statement.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  return result.rows;
}

async function batchRealms(client: AccessClient, ids: readonly string[]): Promise<RealmBatchRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const parameters = { keys: JSON.stringify(unique.map((id) => ({ route: route(id), id }))) };
  const result = await client.query<RealmBatchRow>(
    readRealmBatch.sql,
    readRealmBatch.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  return result.rows;
}

function requiredBanKeys(actor: Actor, boards: readonly Row[]): BanKey[] {
  if (actor.kind !== 'account') return [];
  const accountIds = new Set([
    actor.accountId,
    ...(actor.requestedBy?.split(':')[3] ? [actor.requestedBy.split(':')[3]!] : []),
  ]);
  const realmIds = new Set<string>();
  for (const board of boards) {
    if (board.realm_id && board.visibility !== 'published') realmIds.add(board.realm_id);
  }
  return [...realmIds].map((realmId) => ({
    route: route(realmId),
    realm_id: realmId,
    account_ids: [...accountIds],
  }));
}

function actorBanAccounts(actor: Actor): readonly string[] {
  if (actor.kind !== 'account') return [];
  const principal = actor.requestedBy?.split(':')[3];
  return [...new Set([actor.accountId, ...(principal ? [principal] : [])])];
}

function createBanEvidence(
  client: AccessClient,
  actor: Actor,
  boards: readonly Row[],
): { read(at: string): Promise<ReadonlySet<string>>; current(): Promise<ReadonlySet<string>> } {
  const keys = requiredBanKeys(actor, boards);
  let evidence: Promise<ReadonlySet<string>> | undefined;
  let evidenceAt: string | undefined;
  return {
    async read(at) {
      if (!keys.length) return new Set();
      if (!evidence || evidenceAt !== at) {
        evidenceAt = at;
        const parameters = { keys: JSON.stringify(keys), at };
        evidence = client
          .query<{ route: number; realm_id: string; account_id: string }>(
            banCurrentManyBatch.sql,
            banCurrentManyBatch.params.map((name) => parameters[name as keyof typeof parameters]),
          )
          .then((result) => new Set(result.rows.map((row) => `${row.realm_id}/${row.account_id}`)));
      }
      return evidence;
    },
    async current() {
      return evidence ?? new Set();
    },
  };
}

function decisionAllowed(
  row: Row,
  decision: Readonly<{ allowed: boolean; explicit: boolean }> | undefined,
  actor: Actor,
  tombstone: boolean,
): boolean {
  return !!decision?.allowed && admissible(row, actor, tombstone);
}

/** Every content partition is in this pool's database. One tuple probe reads
 * the anchors, and all following key batches use complete routed identities. */
async function batchSnapshot<T>(
  dependencies: Pick<ContentReadDependencies, 'pool'>,
  ids: readonly string[],
  context: Pick<ReadContext, 'deadline'>,
  work: (client: AccessClient, anchors: ReadonlyMap<number, Partition>) => Promise<T>,
): Promise<{ value: T; anchors: ReadonlyMap<number, Partition> }> {
  const poolGroups = new Map<Pool, Set<number>>([
    [dependencies.pool, new Set(ids.map((id) => partitionOf(route(id))))],
  ]);
  return within(context.deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partitionNos = [...poolGroups.get(dependencies.pool)!];
        const partitions = await readPartitions(client, partitionNos);
        const anchors = new Map(partitions.map((partition) => [partition.partitionNo, partition]));
        for (const partitionNo of partitionNos) {
          const partition = anchors.get(partitionNo);
          if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
          if (partition.writeState === 'moved')
            throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        }
        const value = await work(client, anchors);
        await client.query('COMMIT');
        return { value, anchors };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

export async function prepareBoardPageDecisions(
  dependencies: ContentReadDependencies,
  context: ReadContext,
): Promise<ReadDecisions> {
  const input = {
    actor: context.actor,
    context: { pool: dependencies.pool, deadline: context.deadline },
  };
  try {
    // Realm ownership is discovered inside the candidate snapshot, so prepare
    // the one superset before it whenever the installed catalogue has realm:read.
    return await prepareReadDecisions(dependencies.access, {
      ...input,
      actions: new Set(['thread:read', 'post:read', 'board:read', 'realm:read']),
    });
  } catch (error) {
    // A non-Realm board does not need realm:read. Some direct test/embedded
    // Access catalogues intentionally omit it, and the port rejects that
    // unconfigured action before doing any preparation I/O.
    if (!(error instanceof RangeError) || error.message !== 'Invalid read decision actions') throw error;
    return prepareReadDecisions(dependencies.access, {
      ...input,
      actions: new Set(['thread:read', 'post:read', 'board:read']),
    });
  }
}

async function point(
  client: AccessClient,
  kind: Kind,
  id: string,
  threadId = id,
  bytes = false,
  nativeEligibility = false,
): Promise<Row | null> {
  const parameters = { route: route(id), id, kind, thread_id: threadId, include_body: bytes };
  const values = read.params.map((name) => parameters[name as keyof typeof parameters]);
  const dispatch = () => client.query<Row>(read.sql, values);
  // Access's native eligibility producer already accounts its own verification.
  const { rows } =
    nativeEligibility || !realmSubjectReadRoot(client)
      ? await dispatch()
      : await realmSubjectContentPoint(client, kind, values, dispatch);
  return rows.length === 1 ? rows[0]! : null;
}

/** The terminal null parent must be observed. A cycle, foreign thread, missing
 * row or 33rd reply ancestor is absence, never a truncated visible chain. */
async function chain(
  client: AccessClient,
  threadId: string,
  postId?: string,
  revisionId?: string,
): Promise<Chain | null> {
  const thread = await point(client, 'thread', threadId);
  if (!thread) return null;
  const posts: Row[] = [];
  const seen = new Set<string>();
  let id = postId;
  while (id) {
    if (route(id) !== route(threadId) || seen.has(id) || posts.length >= 33) return null;
    seen.add(id);
    const post = await point(client, 'post', id, threadId);
    if (!post || !post.head_id) return null;
    posts.push(post);
    id = post.parent_id ?? undefined;
  }
  const selected = posts[0];
  const revision = selected ? await point(client, 'revision', revisionId ?? selected.head_id!, threadId) : null;
  if (selected && (!revision || revision.parent_id !== selected.id)) return null;
  return { thread, posts, revision };
}

const signature = (row: Row) =>
  JSON.stringify([
    row.kind,
    row.id,
    row.thread_id,
    row.board_id,
    row.parent_id,
    row.author_id,
    row.head_id,
    row.first_post_id,
    row.thread_kind,
    row.board_purpose,
    row.visibility,
    row.security_revision,
    row.availability,
    row.realm_id,
    row.deleted_at,
    row.restorable,
    row.decision_id,
  ]);
const fingerprint = (value: Chain | null) =>
  value &&
  JSON.stringify([signature(value.thread), ...value.posts.map(signature), value.revision && signature(value.revision)]);

/** A withheld placeholder is authorized only by the current committed
 * moderation decision joined for this row's security revision. */
function isCommittedWithheldReference(row: Row): boolean {
  return row.kind === 'post' && row.visibility === 'taken_down' && row.decision_id !== null;
}

function admissible(row: Row, actor: Actor, tombstone: boolean): boolean {
  if (row.visibility === 'draft' && (actor.kind !== 'account' || row.author_id !== actor.accountId)) return false;
  if (row.visibility === 'taken_down' || row.availability === 'erased') return tombstone;
  return ['published', 'protected', 'draft'].includes(row.visibility);
}

type ErasedReadProof = { explicit: boolean };

/** @internal Shared post-read resources: every domain operand uses the evaluator's principal. */
export function readResource(
  row: Row,
  evidence: object,
  tombstone = false,
  placeholder = false,
  withheldReference = false,
): Resource {
  const action = `${row.kind}:read`;
  const resource = { route: route(row.id), id: row.id };
  const native = createReadEligibilityWork(row, resource.route, evidence);
  const resourceWithEligibility = {
    ...resource,
    eligibility: createResourcePublicEligibility({
      resource,
      action,
      work: native.work,
      async prepare(context) {
        return native.prepare(context);
      },
      async verify(context) {
        const { client, actor, at } = context;
        const current = await native.point(context, () =>
          point(client, row.kind, row.id, row.thread_id ?? row.id, false, true),
        );
        if (!current || signature(current) !== signature(row) || !admissible(current, actor, tombstone))
          throw new ContentNotFoundError();
        if (
          current.kind === 'board' &&
          current.realm_id &&
          current.visibility !== 'published' &&
          actor.kind === 'account'
        ) {
          // Assignment references are authenticated before disclosure. Check both
          // fixed identities, independently of the grant's subject or membership.
          const principal = actor.requestedBy?.split(':')[3];
          const accounts = new Set([actor.accountId, ...(principal ? [principal] : [])]);
          for (const accountId of accounts) {
            const parameters = { route: route(current.id), realm_id: current.realm_id, account_id: accountId, at };
            const values = currentBan.params.map((name) => parameters[name as keyof typeof parameters]);
            const bans = await native.ban(context, values, () =>
              client.query<{ banned: boolean }>(currentBan.sql, values),
            );
            if (bans.rows.length !== 0) throw new ContentNotFoundError();
          }
        }
        // Erased public slots still require the requested scope from account tokens.
        if (placeholder && actor.kind === 'account' && !actor.scopes.includes(action))
          return native.complete(context, false);
        return native.complete(
          context,
          (current.visibility === 'published' ||
            (withheldReference && isCommittedWithheldReference(current) && current.visibility === 'taken_down')) &&
            ((!tombstone && current.availability === 'available') || placeholder),
        );
      },
    }),
  };
  return resourceWithEligibility;
}

/** The shared formula alone supplies floor, grant, scope, account and denial operands. */
async function prepare(
  dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>,
  row: Row,
  context: RealmSubjectReadContext,
  evidence: object,
  tombstone = false,
  placeholder = false,
  erasedProof?: ErasedReadProof,
  withheldReference = false,
  sharedContext?: AccessContext,
): Promise<AccessCheck> {
  const action = `${row.kind}:read`;
  const resourceWithEligibility = readResource(row, evidence, tombstone, placeholder, withheldReference);
  const accessContext = sharedContext ?? {
    pool: dependencies.pool,
    deadline: context.deadline,
    ...(context.work ? { work: context.work } : {}),
  };
  if (erasedProof) {
    const check = await accessExplicitCheck(
      dependencies.access,
      context.actor,
      action,
      resourceWithEligibility,
      accessContext,
    );
    return async (client, time) => {
      const decision = await check(client, time);
      erasedProof.explicit = decision.explicit;
      return decision.allowed;
    };
  }
  const check = await accessCheck(dependencies.access, context.actor, action, resourceWithEligibility, accessContext);
  if (context.work && !check.work) context.work.unavailable(`Content ${action} native work producer`);
  return check;
}

async function observeBoard(
  dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>,
  boardId: BoardId,
  context: ReadContext,
  time?: AuthoritativeTime,
  accessContext?: AccessContext,
): Promise<{ result: Anchored<BoardView | null>; recheck: () => Promise<boolean> }> {
  const observed = await snapshot(dependencies, boardId, context, (client) => point(client, 'board', boardId));
  const row = observed.value;
  const check = row
    ? await prepare(dependencies, row, context, observed, false, false, undefined, false, accessContext)
    : null;
  const checked = async (client: AccessClient): Promise<Row | null> => {
    const current = await point(client, 'board', boardId);
    if (
      !row ||
      !current ||
      signature(row) !== signature(current) ||
      !admissible(current, context.actor, false) ||
      !check
    )
      return null;
    try {
      return (await check(client, time)) ? current : null;
    } catch (error) {
      // A hard board denial conceals this candidate, including in filtered lists.
      if (error instanceof ContentNotFoundError) return null;
      throw error;
    }
  };
  const result = await snapshot(dependencies, boardId, context, async (client): Promise<BoardView | null> => {
    const current = await checked(client);
    if (!current) return null;
    return {
      id: current.id,
      realmId: current.realm_id ?? null,
      route: route(boardId),
      title: current.title,
      purpose: current.board_purpose!,
      visibility: current.visibility,
      securityRevision: current.security_revision,
      availability: current.availability,
      createdAt: current.created_at.toISOString(),
    };
  });
  return {
    result,
    // Preserve the first row and its prepared Access check; never refresh the
    // baseline after a privacy reduction or share a proof across items.
    recheck: async () =>
      (await snapshot(dependencies, boardId, context, async (client) => !!(await checked(client)))).value,
  };
}

export async function readBoard(
  dependencies: ContentReadDependencies,
  boardId: BoardId,
  context: ReadContext,
): Promise<Anchored<import('./model.ts').BoardView | null>> {
  const observed = await observeBoard(dependencies, boardId, context);
  const board = observed.result.value;
  if (!board) return { ...observed.result, value: null };
  if (board.realmId === null) return { ...observed.result, value: { ...board, community: null } };
  const presentation = (await readCommunityPresentations(dependencies, [board.realmId], context)).get(board.realmId);
  if (!presentation || !(await observed.recheck())) return { ...observed.result, value: null };
  return { ...observed.result, value: { ...board, community: presentation } };
}

function boardView(row: Row): BoardView {
  return {
    id: row.id,
    realmId: row.realm_id,
    route: route(row.id),
    title: row.title!,
    purpose: row.board_purpose!,
    visibility: row.visibility,
    securityRevision: row.security_revision,
    availability: row.availability,
    createdAt: row.created_at.toISOString(),
  };
}

function boardRowFromView(board: BoardView): Row {
  return {
    kind: 'board',
    id: board.id,
    thread_id: null,
    board_id: null,
    parent_id: null,
    author_id: null,
    head_id: null,
    first_post_id: null,
    thread_kind: null,
    board_purpose: board.purpose,
    vote_citation: null,
    title: board.title,
    visibility: board.visibility,
    security_revision: board.securityRevision,
    availability: board.availability,
    created_at: new Date(board.createdAt),
    revised_at: null,
    licence: '',
    subject_ids: [],
    media_ids: [],
    body: null,
    sha256: null,
    realm_id: board.realmId,
    deleted_at: null,
    restorable: false,
    decision_id: null,
  };
}

async function decideBoardAndRealms(
  client: AccessClient,
  decisions: ReadDecisions,
  actor: Actor,
  boards: readonly Row[],
  realms: readonly RealmBatchRow[],
): Promise<
  Readonly<{ boards: ReadonlyMap<string, boolean>; realms: ReadonlyMap<string, boolean>; bans: ReadonlySet<string> }>
> {
  const bans = createBanEvidence(client, actor, boards);
  const boardIds = boards.map((row) => row.id);
  const boardRows = new Map(boards.map((row) => [row.id, row]));
  let boardDecisions: Readonly<Record<string, { allowed: boolean; explicit: boolean }>> = Object.create(null);
  if (boardIds.length) {
    boardDecisions = await decisions.decide(client, {
      action: 'board:read',
      resourceType: 'content.board',
      ids: boardIds,
      eligibility: async (_client, ids, at) => {
        await bans.read(at);
        return Object.fromEntries(ids.map((id) => [id, boardRows.get(id)?.visibility === 'published']));
      },
    });
  }
  const realmIds = realms.map((row) => row.realm_id);
  const realmRows = new Map(realms.map((row) => [row.realm_id, row]));
  let realmDecisions: Readonly<Record<string, { allowed: boolean; explicit: boolean }>> = Object.create(null);
  if (realmIds.length) {
    realmDecisions = await decisions.decide(client, {
      action: 'realm:read',
      resourceType: 'community.realm',
      ids: realmIds,
      eligibility: async (_client, ids, at) => {
        await bans.read(at);
        return Object.fromEntries(ids.map((id) => [id, realmRows.get(id)?.visibility === 'public']));
      },
    });
  }
  const banned = await bans.current();
  const accounts = actorBanAccounts(actor);
  const bannedFor = (realmId: string | null) =>
    !!realmId && accounts.some((accountId) => banned.has(`${realmId}/${accountId}`));
  const boardAllowed = new Map(
    boards.map((row) => [
      row.id,
      admissible(row, actor, false) && boardDecisions[row.id]?.allowed === true && !bannedFor(row.realm_id),
    ]),
  );
  const realmAllowed = new Map(
    realms.map((row) => [row.realm_id, realmDecisions[row.realm_id]?.allowed === true && !bannedFor(row.realm_id)]),
  );
  return { boards: boardAllowed, realms: realmAllowed, bans: banned };
}

export async function readBoardPageCandidateSnapshot<T>(
  dependencies: ContentReadDependencies,
  boardId: BoardId,
  context: ReadContext,
  decisions: ReadDecisions,
  candidatePage: (client: AccessClient, partition: Partition) => Promise<T>,
): Promise<Readonly<{ board: BoardView; anchor: Anchored<BoardView>; candidate: T }> | null> {
  const observed = await batchSnapshot(dependencies, [boardId], context, async (client, anchors) => {
    const partition = anchors.get(partitionOf(route(boardId)))!;
    const boards = await batchRows(client, 'board', [batchKey(boardId)]);
    const row = boards[0] ?? null;
    const realms = row?.realm_id ? await batchRealms(client, [row.realm_id]) : [];
    // Candidate identities are inert. Read the range before evaluating the two
    // parent decisions, then discard it when either parent is hidden.
    const candidate = await candidatePage(client, partition);
    if (!row) return null;
    const checked = await decideBoardAndRealms(client, decisions, context.actor, [row], realms);
    const realmAllowed = !row.realm_id || checked.realms.get(row.realm_id) === true;
    if (!checked.boards.get(row.id) || !realmAllowed) return null;
    return { row, realm: realms[0] ?? null, candidate };
  });
  if (!observed.value) return null;
  const partition = observed.anchors.get(partitionOf(route(boardId)))!;
  const anchor = { partition, epoch: partition.epoch, position: partition.position };
  const view = boardView(observed.value.row);
  return { board: view, anchor: { value: view, anchor }, candidate: observed.value.candidate };
}

function contentFloor(row: Row, tombstone: boolean, placeholder: boolean, withheldReference = false): boolean {
  return (
    (row.visibility === 'published' ||
      (withheldReference && isCommittedWithheldReference(row) && row.visibility === 'taken_down')) &&
    ((!tombstone && row.availability === 'available') || placeholder)
  );
}

type SelectionRound = Readonly<{
  survivors: readonly string[];
  revisions: ReadonlyMap<string, string>;
  anchors: readonly AnchoredPosition[];
}>;

export async function selectBoardThreadCandidates(
  dependencies: ContentReadDependencies,
  boardId: BoardId,
  threadIds: readonly string[],
  context: ReadContext,
  decisions: ReadDecisions,
  query = '',
): Promise<SelectionRound> {
  if (!threadIds.length) return { survivors: [], revisions: new Map(), anchors: [] };
  const selected = await batchSnapshot(dependencies, threadIds, context, async (client) => {
    const threads = await batchRows(
      client,
      'thread',
      threadIds.map((id) => batchKey(id)),
    );
    const threadById = new Map(threads.map((row) => [row.id, row]));
    const posts = await batchRows(
      client,
      'post',
      threads.filter((row) => row.first_post_id).map((row) => batchKey(row.first_post_id!, row.id)),
    );
    const postByThread = new Map(posts.map((row) => [row.thread_id!, row]));
    const revisions = await batchRows(
      client,
      'revision',
      posts.filter((row) => row.head_id).map((row) => batchKey(row.head_id!, row.thread_id!)),
      false,
      query,
    );
    const revisionByPost = new Map(revisions.map((row) => [row.parent_id!, row]));
    const tombstones = new Map<string, boolean>();
    const placeholders = new Map<string, boolean>();
    const withheld = new Map<string, boolean>();
    for (const threadId of threadIds) {
      const post = postByThread.get(threadId);
      const revision = post ? revisionByPost.get(post.id) : undefined;
      const erased = !!post && (post.availability === 'erased' || revision?.availability === 'erased');
      const isWithheld = !!post && !erased && isCommittedWithheldReference(post);
      tombstones.set(threadId, erased);
      if (post) {
        tombstones.set(post.id, erased || isWithheld || post.availability === 'erased');
        placeholders.set(post.id, post.availability === 'erased' || isWithheld);
        withheld.set(post.id, isWithheld);
      }
    }
    const threadEligible = new Map(
      threads.map((row) => [row.id, contentFloor(row, tombstones.get(row.id) ?? false, false)]),
    );
    const postEligible = new Map(
      posts.map((row) => [
        row.id,
        contentFloor(
          row,
          tombstones.get(row.id) ?? false,
          placeholders.get(row.id) ?? false,
          withheld.get(row.id) ?? false,
        ),
      ]),
    );
    const threadAccess = threads.length
      ? await decisions.decide(client, {
          action: 'thread:read',
          resourceType: 'content.thread',
          ids: threads.map((row) => row.id),
          eligibility: async (_client, ids) =>
            Object.fromEntries(ids.map((id) => [id, threadEligible.get(id) === true])),
        })
      : {};
    const postAccess = posts.length
      ? await decisions.decide(client, {
          action: 'post:read',
          resourceType: 'content.post',
          ids: posts.map((row) => row.id),
          eligibility: async (_client, ids) => Object.fromEntries(ids.map((id) => [id, postEligible.get(id) === true])),
        })
      : {};
    const survivors: string[] = [];
    const expected = new Map<string, string>();
    for (const id of threadIds) {
      const thread = threadById.get(id);
      const post = postByThread.get(id);
      const revision = post ? revisionByPost.get(post.id) : undefined;
      if (
        !thread ||
        !post ||
        !revision ||
        thread.board_id !== boardId ||
        !decisionAllowed(thread, threadAccess[id], context.actor, tombstones.get(id) ?? false) ||
        !decisionAllowed(post, postAccess[post.id], context.actor, tombstones.get(post.id) ?? false)
      )
        continue;
      if (
        query &&
        (post.availability !== 'available' || revision.availability !== 'available' || revision.matches !== true)
      )
        continue;
      survivors.push(id);
      expected.set(id, revision.id);
    }
    return { survivors, revisions: expected };
  });
  const anchors = [...selected.anchors.values()].map((partition) => ({
    partition,
    epoch: partition.epoch,
    position: partition.position,
  }));
  return { ...selected.value, anchors };
}

export async function discloseBoardPageThreads(
  dependencies: ContentReadDependencies,
  boardId: BoardId,
  baseline: BoardView,
  threadIds: readonly string[],
  expectedRevisions: ReadonlyMap<string, string>,
  context: ReadContext,
  decisions: ReadDecisions,
  query = '',
): Promise<
  Readonly<{
    items: readonly Anchored<ThreadView | null>[];
    boardAnchor: AnchoredPosition;
    parentAllowed: boolean;
  }>
> {
  const ids = [boardId, ...threadIds];
  if (baseline.realmId) ids.push(baseline.realmId);
  const result = await batchSnapshot(dependencies, ids, context, async (client, anchors) => {
    const currentBoards = await batchRows(client, 'board', [batchKey(boardId)]);
    const currentBoard = currentBoards[0];
    if (!currentBoard || signature(currentBoard) !== signature(boardRowFromView(baseline)))
      return { items: new Map<string, ThreadView | null>(), parentAllowed: false };
    const realms = currentBoard.realm_id ? await batchRealms(client, [currentBoard.realm_id]) : [];
    const parentChecks = await decideBoardAndRealms(client, decisions, context.actor, [currentBoard], realms);
    if (!parentChecks.boards.get(boardId) || (currentBoard.realm_id && !parentChecks.realms.get(currentBoard.realm_id)))
      return { items: new Map<string, ThreadView | null>(), parentAllowed: false };

    // Parent authorities pass in this same snapshot before any thread chain row is read.
    const threads = await batchRows(
      client,
      'thread',
      threadIds.map((id) => batchKey(id)),
    );
    const byThread = new Map(threads.map((row) => [row.id, row]));
    const posts = await batchRows(
      client,
      'post',
      threads.filter((row) => row.first_post_id).map((row) => batchKey(row.first_post_id!, row.id)),
    );
    const postByThread = new Map(posts.map((row) => [row.thread_id!, row]));
    const revisions = await batchRows(
      client,
      'revision',
      posts.filter((row) => row.head_id).map((row) => batchKey(row.head_id!, row.thread_id!)),
    );
    const revisionByPost = new Map(revisions.map((row) => [row.parent_id!, row]));
    const threadTombstone = new Map<string, boolean>();
    const postTombstone = new Map<string, boolean>();
    const postPlaceholder = new Map<string, boolean>();
    const postWithheld = new Map<string, boolean>();
    for (const [id, post] of postByThread) {
      const revision = revisionByPost.get(post.id);
      const erased = post.availability === 'erased' || revision?.availability === 'erased';
      const withheld = !erased && isCommittedWithheldReference(post);
      threadTombstone.set(id, erased);
      postTombstone.set(post.id, erased || withheld || post.availability === 'erased');
      postPlaceholder.set(post.id, post.availability === 'erased' || withheld);
      postWithheld.set(post.id, withheld);
    }
    const threadFloor = new Map(
      threads.map((row) => [row.id, contentFloor(row, threadTombstone.get(row.id) ?? false, false)]),
    );
    const postFloor = new Map(
      posts.map((row) => [
        row.id,
        contentFloor(
          row,
          postTombstone.get(row.id) ?? false,
          postPlaceholder.get(row.id) ?? false,
          postWithheld.get(row.id) ?? false,
        ),
      ]),
    );
    const threadAccess = threads.length
      ? await decisions.decide(client, {
          action: 'thread:read',
          resourceType: 'content.thread',
          ids: threads.map((row) => row.id),
          eligibility: async (_client, ids2) =>
            Object.fromEntries(ids2.map((id) => [id, threadFloor.get(id) === true])),
        })
      : {};
    const postAccess = posts.length
      ? await decisions.decide(client, {
          action: 'post:read',
          resourceType: 'content.post',
          ids: posts.map((row) => row.id),
          eligibility: async (_client, ids2) => Object.fromEntries(ids2.map((id) => [id, postFloor.get(id) === true])),
        })
      : {};
    const passed: string[] = [];
    for (const id of threadIds) {
      const thread = byThread.get(id);
      const post = postByThread.get(id);
      const revision = post ? revisionByPost.get(post.id) : undefined;
      const erased = !!post && (post.availability === 'erased' || revision?.availability === 'erased');
      const withheld = !!postWithheld.get(post?.id ?? '');
      if (
        !thread ||
        !post ||
        !revision ||
        thread.board_id !== boardId ||
        !decisionAllowed(thread, threadAccess[id], context.actor, threadTombstone.get(id) ?? false) ||
        !decisionAllowed(post, postAccess[post.id], context.actor, postTombstone.get(post.id) ?? false) ||
        (erased && postAccess[post.id]?.explicit !== true && thread.visibility === 'taken_down')
      )
        continue;
      if (
        query &&
        (expectedRevisions.get(id) !== revision.id ||
          post.availability !== 'available' ||
          revision.availability !== 'available')
      )
        continue;
      if (withheld && !postPlaceholder.get(post.id)) continue;
      passed.push(id);
    }
    let matched = new Set(passed);
    if (query && passed.length) {
      const matchKeys = passed.map((id) => {
        const post = postByThread.get(id)!;
        const revision = revisionByPost.get(post.id)!;
        return { route: route(post.id), thread_id: id, post_id: post.id, revision_id: revision.id };
      });
      const parameters = { keys: JSON.stringify(matchKeys), query };
      const rows = await client.query<{ thread_id: string; matches: boolean }>(
        matchThreadTextBatch.sql,
        matchThreadTextBatch.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      matched = new Set(rows.rows.filter((row) => row.matches).map((row) => row.thread_id));
    }
    const bodyIds = passed.filter((id) => {
      if (!matched.has(id)) return false;
      const post = postByThread.get(id)!;
      const revision = revisionByPost.get(post.id)!;
      return !postWithheld.get(post.id) && post.availability === 'available' && revision.availability === 'available';
    });
    const bodies = await batchRows(
      client,
      'revision',
      bodyIds.map((id) => {
        const post = postByThread.get(id)!;
        return batchKey(revisionByPost.get(post.id)!.id, id);
      }),
      true,
    );
    const bodyByPost = new Map(bodies.map((row) => [row.parent_id!, row]));
    const output = new Map<string, ThreadView | null>();
    for (const id of passed) {
      const thread = byThread.get(id)!;
      const post = postByThread.get(id)!;
      const revision = bodyByPost.get(post.id) ?? revisionByPost.get(post.id);
      if (!revision) continue;
      const erased = post.availability === 'erased' || revision.availability === 'erased';
      const withheld = !!postWithheld.get(post.id);
      const explicit = postAccess[post.id]?.explicit === true;
      let item: PostEntry | null =
        erased && !explicit ? erasedPlaceholder(post) : itemView(post, revision, erased, withheld);
      if (!item) continue;
      if (context.actor.kind === 'account' && context.actor.accountId === post.author_id) {
        const until = post.deleted_at ? post.deleted_at.getTime() + 30 * 86400000 : 0;
        if (
          item.availability === 'erased' &&
          post.restorable &&
          until > (dependencies.clock?.() ?? new Date()).getTime()
        )
          item = { ...item, restorableUntil: new Date(until).toISOString() };
        if (item.availability === 'withheld' && post.decision_id) item = { ...item, decisionId: post.decision_id };
      }
      output.set(id, {
        id: thread.id,
        route: route(thread.id),
        authorId: thread.author_id!,
        kind: thread.thread_kind!,
        title: erased ? null : thread.title,
        licence: revision.licence,
        subjectIds: revision.subject_ids,
        boardId: thread.board_id!,
        visibility: thread.visibility,
        securityRevision: thread.security_revision,
        availability: thread.availability,
        createdAt: thread.created_at.toISOString(),
        firstPost: item,
      });
    }
    return { items: output, parentAllowed: true };
  });
  for (const [id, thread] of result.value.items) {
    if (thread) result.value.items.set(id, await readableCitation(dependencies, context, thread));
  }
  const items = threadIds.map((id) => {
    const partition = result.anchors.get(partitionOf(route(id)))!;
    return {
      value: result.value.items.get(id) ?? null,
      anchor: { partition, epoch: partition.epoch, position: partition.position },
    };
  });
  const boardPartition = result.anchors.get(partitionOf(route(boardId)))!;
  return {
    items,
    boardAnchor: { partition: boardPartition, epoch: boardPartition.epoch, position: boardPartition.position },
    parentAllowed: result.value.parentAllowed,
  };
}

async function disclose(
  dependencies: ContentReadDependencies,
  threadId: string,
  context: ReadContext,
  postId?: string,
  revisionId?: string,
  threadDetail = false,
  replayedRevisionId?: string,
  subjectScope?: { subjectId: string; placeId: string },
  threadReference = threadDetail,
  beforeFinal?: () => Promise<void>,
  metadataOnly = false,
): Promise<Anchored<PostEntry | ThreadView | NativeDraftMetadata | null>> {
  const observed = await snapshot(dependencies, threadId, context, async (client) => {
    if (threadDetail) {
      const thread = await point(client, 'thread', threadId);
      return thread?.first_post_id ? chain(client, threadId, thread.first_post_id) : null;
    }
    return chain(client, threadId, postId, revisionId);
  });
  const initial = observed.value;
  const boardObservation = initial?.thread.board_id
    ? await observeBoard(dependencies, initial.thread.board_id, context)
    : null;
  const board = boardObservation?.result;
  const erased =
    !!initial && (initial.posts[0]?.availability === 'erased' || initial.revision?.availability === 'erased');
  const rows = initial ? [initial.thread, ...initial.posts] : [];
  const checks: AccessCheck[] = [];
  const erasedProof = erased ? { explicit: false } : undefined;
  const withheld = threadReference && !erased && !!initial?.posts[0] && isCommittedWithheldReference(initial.posts[0]);
  if (board?.value) {
    for (const row of rows) {
      const withheldReference = threadReference && isCommittedWithheldReference(row);
      const erasureRead =
        withheldReference ||
        row.availability === 'erased' ||
        (erased && (row === initial?.posts[0] || row.visibility === 'taken_down'));
      const placeholder =
        row.kind === 'post' &&
        (row.availability === 'erased' || withheldReference) &&
        !(revisionId && row === initial?.posts[0]);
      checks.push(
        await prepare(
          dependencies,
          row,
          context,
          { observed, board },
          erasureRead,
          placeholder,
          row === initial?.posts[0] ? erasedProof : undefined,
          withheldReference,
        ),
      );
    }
  }
  const discloseCurrent = async (
    client: AccessClient,
  ): Promise<PostEntry | ThreadView | NativeDraftMetadata | null> => {
    if (!initial || !board?.value || checks.length !== rows.length) return null;
    const current = await chain(client, threadId, initial.posts[0]?.id, revisionId);
    if (!current || fingerprint(initial) !== fingerprint(current)) return null;
    if (subjectScope) {
      if (!current.revision?.subject_ids.includes(subjectScope.subjectId) || !current.thread.board_id) return null;
      const boardRoute = route(current.thread.board_id);
      const parameters = { route: boardRoute, id: current.thread.board_id };
      const boardPlace = await client.query<(typeof readThreadPlace)['~reylo']['element']>(
        readThreadPlace.sql,
        readThreadPlace.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      const realmId = boardPlace.rows[0]?.realm_id ?? null;
      if (boardPlace.rows.length !== 1 || (realmId ?? GLOBAL_CONTEXT) !== subjectScope.placeId) return null;
    }
    for (let index = 0; index < rows.length; index++) {
      if (
        !admissible(
          rows[index]!,
          context.actor,
          erased ||
            rows[index]!.availability === 'erased' ||
            (threadReference && isCommittedWithheldReference(rows[index]!)),
        ) ||
        !(await checks[index]!(client))
      )
        return null;
    }
    if (!current.revision || !current.posts[0]) return null;
    if (metadataOnly) {
      const post = current.posts[0];
      const revision = current.revision;
      if (
        erased ||
        withheld ||
        post.visibility !== 'draft' ||
        context.actor.kind !== 'account' ||
        post.author_id !== context.actor.accountId ||
        revision.availability !== 'available'
      )
        return null;
      return {
        id: post.id,
        threadId,
        firstPostId: current.thread.first_post_id!,
        revisionId: revision.id,
        authorId: post.author_id,
        kind: current.thread.thread_kind!,
        documentKind: post.id === current.thread.first_post_id ? 'opening' : 'reply',
        title: post.id === current.thread.first_post_id ? (current.thread.title?.slice(0, 512) ?? null) : null,
        savedAt: revision.created_at.toISOString(),
        licence: revision.licence,
        subjectIds: revision.subject_ids,
        mediaIds: revision.media_ids,
        board: { id: board.value!.id, title: board.value!.title?.slice(0, 512) ?? null, realmId: board.value!.realmId },
      };
    }
    // The receipt names one exact revision. That replay is the erased-metadata
    // proof for that revision alone; taken down and every other check still deny.
    const replayAuthorizes =
      replayedRevisionId !== undefined &&
      revisionId === replayedRevisionId &&
      current.revision.id === replayedRevisionId;
    if (
      erasedProof &&
      !erasedProof.explicit &&
      ((revisionId && !replayAuthorizes) ||
        [current.thread, ...current.posts].some(
          (row) => row.visibility === 'taken_down' && !(threadReference && isCommittedWithheldReference(row)),
        ))
    )
      return null;
    // Logical erasure suppresses retained bytes for both head and exact reads.
    // Available bytes are loaded only after every container and Access check passes.
    const revision =
      erased || withheld ? current.revision : await point(client, 'revision', current.revision.id, threadId, true);
    if (!revision || revision.parent_id !== current.posts[0].id) return null;
    let item: PostEntry | null =
      erasedProof && !erasedProof.explicit && !replayAuthorizes
        ? erasedPlaceholder(current.posts[0])
        : itemView(current.posts[0], revision, erased, withheld);
    if (!item) return null;
    const post = current.posts[0];
    if (context.actor.kind === 'account' && context.actor.accountId === post.author_id) {
      const until = post.deleted_at ? post.deleted_at.getTime() + 30 * 86400000 : 0;
      if (item.availability === 'erased' && post.restorable && until > (dependencies.clock?.() ?? new Date()).getTime())
        item = { ...item, restorableUntil: new Date(until).toISOString() };
      if (item.availability === 'withheld' && post.decision_id) item = { ...item, decisionId: post.decision_id };
    }
    if (!threadDetail) return item;
    const thread = current.thread;
    return {
      id: thread.id,
      route: route(thread.id),
      authorId: thread.author_id!,
      kind: thread.thread_kind!,
      title: erased ? null : thread.title,
      licence: revision.licence,
      subjectIds: revision.subject_ids,
      boardId: thread.board_id!,
      visibility: thread.visibility,
      securityRevision: thread.security_revision,
      availability: thread.availability,
      createdAt: thread.created_at.toISOString(),
      firstPost: item,
    };
  };
  let disclosed = await snapshot(dependencies, threadId, context, discloseCurrent);
  // Admission may consult independent anchors only after ordinary disclosure has
  // succeeded and released its connections. Keep the original rows/checks as the
  // baseline for final disclosure; a changed container must not become a new baseline.
  if (beforeFinal && disclosed.value) {
    if (!(await boardObservation!.recheck())) return { ...disclosed, value: null };
    await beforeFinal();
    const scope = currentRealmDisclosureScope();
    if (scope) {
      delete scope.associationCheck;
      delete scope.accessCheck;
    }
    disclosed = await snapshot(dependencies, threadId, context, discloseCurrent);
  }
  // Release the thread connection before the independently anchored board
  // snapshot, including when the pool has only one connection. Bytes and keys
  // leave this function only after both authorities have passed their final check.
  if (disclosed.value && !(await boardObservation!.recheck())) return { ...disclosed, value: null };
  if (disclosed.value && !('firstPostId' in disclosed.value))
    disclosed = { ...disclosed, value: await readableCitation(dependencies, context, disclosed.value) };
  return disclosed;
}

/** Independently anchored question authorization runs only after content releases
 * its snapshots. An unreadable question suppresses the citation, preserving the
 * ordinary post and its own disclosure checks; unavailable authority propagates. */
async function readableCitation<T extends PostEntry | ThreadView>(
  dependencies: ContentReadDependencies,
  context: ReadContext,
  value: T,
): Promise<T> {
  const post = 'firstPost' in value ? value.firstPost : value;
  const citation = 'voteCitation' in post ? post.voteCitation : null;
  if (!citation || citation.questionId === STANDARD_QUESTION_ID) return value;
  let readable = false;
  try {
    readable = !!(await readVisibleRatingQuestion(dependencies, context.actor, citation.questionId, context.deadline));
  } catch (error) {
    if (!(error instanceof ProblemError && error.code === 'not_found')) throw error;
  }
  if (readable) return value;
  const filtered = { ...post, voteCitation: null };
  return ('firstPost' in value ? { ...value, firstPost: filtered } : filtered) as T;
}

function erasedPlaceholder(post: Row): ErasedPlaceholder {
  return {
    id: post.id,
    threadId: post.thread_id!,
    route: route(post.id),
    parentId: post.parent_id,
    removed: true,
    availability: 'erased',
    body: null,
    sha256: null,
  };
}

function itemView(post: Row, revision: Row, erased: boolean, withheld = false): ItemView | WithheldPostEntry | null {
  const metadata = {
    id: post.id,
    threadId: post.thread_id!,
    route: route(post.id),
    authorId: post.author_id!,
    parentId: post.parent_id,
    licence: revision.licence,
    subjectIds: revision.subject_ids,
    boardId: revision.board_id!,
    visibility: post.visibility,
    securityRevision: post.security_revision,
    createdAt: post.created_at.toISOString(),
    revisedAt: post.revised_at === null ? null : post.revised_at.toISOString(),
    mediaIds: revision.media_ids,
    voteCitation: erased ? null : revision.vote_citation,
    revisionId: revision.id,
  };
  if (erased) return { ...metadata, removed: true, body: null, sha256: null, availability: 'erased' };
  if (withheld) return { ...metadata, removed: true, body: null, sha256: null, availability: 'withheld' };
  if (revision.sha256 === null) throw new Error('Live revision is missing its body digest');
  if (revision.availability !== 'available' || !revision.body) return null;
  return {
    ...metadata,
    body: JSON.parse(revision.body.toString('utf8')),
    sha256: revision.sha256.toString('hex'),
    availability: 'available',
  };
}

function isPlaceholder(target: { readonly id: string }): target is ErasedPlaceholder {
  return isErasedPlaceholder(target as StoredItemView | ErasedPlaceholder);
}

/** One partition seek for the account viewer's slots. Anonymous responses omit the field. */
export async function withViewerReactions<T extends { readonly id: string }>(
  dependencies: ContentReadDependencies,
  actor: Actor,
  targets: readonly T[],
  deadline: number,
): Promise<readonly (T & { viewerReaction?: ViewerReactionKind | null })[]> {
  if (actor.kind !== 'account' || targets.length === 0) return targets;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (isPlaceholder(target) || seen.has(target.id)) continue;
    seen.add(target.id);
    ids.push(target.id);
  }
  if (ids.length === 0) return targets;
  if (ids.length > 100) throw new RangeError('At most 100 viewer reaction targets');
  const home = routeOf(actor.accountId);
  if (home === null) throw new TypeError('Invalid content identity');
  const parameters = { route: home, actor_id: actor.accountId, target_ids: ids };
  // Query the compiled statement directly. run() probes schema freshness once,
  // which would add a statement on the first page and nowhere else.
  const rows = await within(deadline, () =>
    withConnection(dependencies.pool, (client) =>
      client.query<(typeof viewerReactions)['~reylo']['element']>(
        viewerReactions.sql,
        viewerReactions.params.map((name) => parameters[name as keyof typeof parameters]),
      ),
    ),
  );
  const kinds = new Map<string, ViewerReactionKind>();
  for (const row of rows.rows) {
    const targetId = row.targetId;
    const kind = row.kind;
    if (targetId === null || typeof kind !== 'string' || !reactionKinds.has(kind))
      throw new TypeError('Invalid reaction kind');
    kinds.set(targetId, kind as ViewerReactionKind);
  }
  return targets.map((target) =>
    isPlaceholder(target) ? target : { ...target, viewerReaction: kinds.get(target.id) ?? null },
  );
}

export type ReactionCountFreshness = Readonly<{ epoch: number; position: string }>;
type ReactionCountMap = Partial<Record<ViewerReactionKind, number>>;
export type SubjectReactionKind = (typeof subjectReactionKinds)[number];
export type SubjectReactionCount = Readonly<{ kind: SubjectReactionKind; count: number }>;
export type SubjectReactionCounts = readonly SubjectReactionCount[];
type Counted<T> = T extends ErasedPlaceholder & { readonly revisionId?: never }
  ? T
  : T & { readonly reactions: ReactionCountMap };

/** One index seek per partition over the page's targets. Zero kinds are omitted.
 * The freshness is the oldest source watermark among the count rows actually read. */
export async function withReactionCounts<T extends { readonly id: string }>(
  dependencies: ContentReadDependencies,
  targets: readonly T[],
  deadline: number,
): Promise<{
  readonly items: readonly Counted<T>[];
  readonly reactionsAsOf: ReactionCountFreshness | null;
}> {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (isPlaceholder(target) || seen.has(target.id)) continue;
    seen.add(target.id);
    ids.push(target.id);
  }
  if (ids.length > 100) throw new RangeError('At most 100 reaction count targets');
  const groups = new Map<number, { ids: string[]; routes: number[] }>();
  for (const id of ids) {
    const home = route(id);
    const partition = partitionOf(home);
    const group = groups.get(partition) ?? { ids: [], routes: [] };
    group.ids.push(id);
    group.routes.push(home);
    groups.set(partition, group);
  }
  const sums = new Map<string, Map<ViewerReactionKind, number>>();
  let oldest: { epoch: number; position: bigint } | null = null;
  for (const [partition, group] of groups) {
    const parameters = { partition, target_ids: group.ids, routes: group.routes };
    const rows = await within(deadline, () =>
      withConnection(dependencies.pool, (client) =>
        client.query<(typeof pageCounts)['~reylo']['element']>(
          pageCounts.sql,
          pageCounts.params.map((name) => parameters[name as keyof typeof parameters]),
        ),
      ),
    );
    for (const row of rows.rows) {
      const kind = row.kind;
      if (typeof row.targetId !== 'string' || typeof kind !== 'string' || !reactionKinds.has(kind))
        throw new TypeError('Invalid reaction count');
      if (!Number.isSafeInteger(row.count) || row.count < 0) throw new TypeError('Invalid reaction count');
      if (!Number.isSafeInteger(row.sourceEpoch) || row.sourceEpoch < 1) throw new TypeError('Invalid reaction count');
      const position = BigInt(row.sourcePosition);
      if (position < 1n) throw new TypeError('Invalid reaction count');
      const counted = sums.get(row.targetId) ?? new Map<ViewerReactionKind, number>();
      const reactionKind = kind as ViewerReactionKind;
      counted.set(reactionKind, (counted.get(reactionKind) ?? 0) + row.count);
      sums.set(row.targetId, counted);
      if (
        oldest === null ||
        row.sourceEpoch < oldest.epoch ||
        (row.sourceEpoch === oldest.epoch && position < oldest.position)
      ) {
        oldest = { epoch: row.sourceEpoch, position };
      }
    }
  }
  return {
    items: targets.map((target) => {
      if (isPlaceholder(target)) return target;
      const counted = sums.get(target.id);
      const reactions: ReactionCountMap = {};
      for (const kind of REACTION_KINDS) {
        const count = counted?.get(kind) ?? 0;
        if (count > 0) reactions[kind] = count;
      }
      return { ...target, reactions };
    }) as Counted<T>[],
    reactionsAsOf: oldest === null ? null : { epoch: oldest.epoch, position: oldest.position.toString() },
  };
}

/** Read at most five relayed subject totals per id with one statement per target partition. */
export async function readSubjectReactionCounts(
  dependencies: Pick<ContentReadDependencies, 'pool'>,
  subjectIds: readonly string[],
  deadline?: number,
): Promise<Map<string, SubjectReactionCounts>> {
  if (subjectIds.length < 1 || subjectIds.length > 100)
    throw new RangeError('Subject reaction count reads require 1 to 100 ids');
  const counts = new Map<string, SubjectReactionCount[]>();
  const groups = new Map<number, { ids: string[]; routes: number[] }>();
  for (const id of subjectIds) {
    let targetRoute = routeOf(id);
    if (targetRoute === null) throw new TypeError('Invalid content identity');
    if (counts.has(id)) continue;
    counts.set(id, []);
    const partition = partitionOf(targetRoute);
    const group = groups.get(partition) ?? { ids: [], routes: [] };
    group.ids.push(id);
    group.routes.push(targetRoute);
    groups.set(partition, group);
  }

  for (const [partition, group] of groups) {
    const parameters = { partition, target_ids: group.ids, routes: group.routes };
    const read = () =>
      withConnection(dependencies.pool, (client) =>
        client.query<(typeof pageSubjectReactionCounts)['~reylo']['element']>(
          pageSubjectReactionCounts.sql,
          pageSubjectReactionCounts.params.map((name) => parameters[name as keyof typeof parameters]),
        ),
      );
    const result = deadline === undefined ? await read() : await within(deadline, read);
    for (const row of result.rows) {
      if (typeof row.targetId !== 'string' || !subjectReactionKinds.includes(row.kind as SubjectReactionKind))
        throw new TypeError('Invalid subject reaction count');
      if (!Number.isSafeInteger(row.count) || row.count < 0) throw new TypeError('Invalid subject reaction count');
      const counted = counts.get(row.targetId);
      if (!counted) throw new TypeError('Unexpected subject reaction count target');
      if (row.count > 0) counted.push({ kind: row.kind as SubjectReactionKind, count: row.count });
    }
  }
  const result = new Map<string, SubjectReactionCounts>();
  for (const [id, rows] of counts) result.set(id, rows);
  return result;
}

export async function readThread(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  context: ReadContext,
): Promise<Anchored<ThreadView | null>> {
  return withRealmDisclosureScope(
    async () =>
      (await disclose(
        dependencies,
        threadId,
        context,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true,
        threadReadAdmission.getStore(),
      )) as Anchored<ThreadView | null>,
  );
}
/** Subject listings use the same final thread, post, board and Access checks as exact thread reads, then
 * confirm the current subject reference and board's current Global/Realm placement in that snapshot. */
export async function readSubjectThread(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  subjectId: string,
  placeId: string,
  context: ReadContext,
): Promise<Anchored<ThreadView | null>> {
  return (await disclose(dependencies, threadId, context, undefined, undefined, true, undefined, {
    subjectId,
    placeId,
  })) as Anchored<ThreadView | null>;
}
/** Internal exact-opening evidence. This shares the ordinary native resources,
 * board observation, ancestry, account fences and Access evaluator. It loads no
 * document bytes and cannot enumerate candidates or establish census coverage.
 */
export async function prepareRealmSubjectThreadDisclosure(
  dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>,
  candidate: Readonly<{ threadId: string; openingPostId: string; subjectId: string }>,
  realmId: string,
  context: RealmSubjectReadContext,
): Promise<
  Readonly<{
    state: 'positive' | 'absent' | 'withheld';
    signature: string | null;
    anchors: readonly AnchoredPosition[];
    final(): Promise<Readonly<{ signature: string; anchors: readonly AnchoredPosition[] }> | null>;
  }>
> {
  const observed = await snapshot(dependencies, candidate.threadId, context, async (client) => {
    const thread = await point(client, 'thread', candidate.threadId);
    return thread?.first_post_id ? chain(client, candidate.threadId, thread.first_post_id) : null;
  });
  const initial = observed.value;
  const unavailable = {
    state: 'withheld' as const,
    signature: null,
    anchors: [],
    final: async () => null,
  };
  if (!initial?.thread.board_id || !initial.revision || !initial.posts[0]) return unavailable;
  const boardObservation = await observeBoard(dependencies, initial.thread.board_id, context);
  const board = boardObservation.result;
  if (!board.value) return unavailable;
  const rows = [initial.thread, ...initial.posts];
  const checks: AccessCheck[] = [];
  for (const row of rows) {
    // Exact positive evidence never comes from erased or withheld placeholders.
    if (!['published', 'protected'].includes(row.visibility) || row.availability !== 'available') return unavailable;
    checks.push(await prepare(dependencies, row, context, { observed, board }));
  }
  if (initial.revision.availability !== 'available') return unavailable;
  const sourceSignature = (value: Chain) =>
    JSON.stringify([
      fingerprint(value),
      value.revision?.subject_ids,
      value.revision?.sha256?.toString('hex'),
      value.revision?.licence,
      board.value,
    ]);
  const baseline = sourceSignature(initial);
  const allowed = async (client: AccessClient) => {
    const current = await chain(client, candidate.threadId, initial.posts[0]!.id);
    if (!current || sourceSignature(current) !== baseline) return false;
    for (let index = 0; index < checks.length; index++) if (!(await checks[index]!(client))) return false;
    return true;
  };
  if (!(await snapshot(dependencies, candidate.threadId, context, allowed)).value) return unavailable;
  if (!(await boardObservation.recheck())) return unavailable;
  const exact =
    initial.thread.first_post_id === candidate.openingPostId &&
    initial.posts[0].id === candidate.openingPostId &&
    initial.posts[0].parent_id === null &&
    initial.revision.parent_id === candidate.openingPostId &&
    initial.revision.board_id === initial.thread.board_id &&
    initial.revision.subject_ids.includes(candidate.subjectId) &&
    board.value.realmId === realmId &&
    ((initial.thread.thread_kind === 'discussion' && board.value.purpose === 'discussion') ||
      (initial.thread.thread_kind === 'review' && board.value.purpose === 'reviews'));
  return {
    state: exact ? 'positive' : 'absent',
    signature: createHash('sha256').update(baseline).digest('hex'),
    anchors: [observed.anchor, board.anchor],
    async final() {
      // Reuse the original baseline. Re-reading cannot bless a changed source.
      const current = await snapshot(dependencies, candidate.threadId, context, allowed);
      if (
        !current.value ||
        current.anchor.epoch !== observed.anchor.epoch ||
        current.anchor.position < observed.anchor.position ||
        !(await boardObservation.recheck())
      )
        return null;
      return {
        signature: createHash('sha256').update(baseline).digest('hex'),
        anchors: [current.anchor],
      };
    },
  };
}
/** Send-time disclosure uses the ordinary read resources and current account standing,
 * without constructing a bearer principal. Release every observation before Access checks. */
export async function postReadableByAccount(
  dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>,
  accountId: string,
  threadId: string,
  postId: string,
  context: Pick<ReadContext, 'deadline'>,
): Promise<boolean> {
  try {
    const observed = await snapshot(dependencies, threadId, context, (client) => chain(client, threadId, postId));
    const initial = observed.value;
    if (!initial?.thread.board_id || initial.thread.visibility === 'draft') return false;
    const boardId = initial.thread.board_id;
    const board = await snapshot(dependencies, boardId, context, (client) => point(client, 'board', boardId));
    if (!board.value) return false;
    const evidence = { observed, board };
    const check = async (row: Row) => {
      const decisions = await accountStandingCheck(dependencies.access, {
        accountId,
        action: `${row.kind}:read`,
        target: readResource(row, evidence),
        context: { pool: dependencies.pool, deadline: context.deadline },
      });
      return decisions[row.id] === true;
    };
    if (!(await check(board.value)) || !(await check(initial.thread))) return false;
    // HTTP composes this Realm operand around thread/post reads. The standing port
    // consumes the same Realm resource directly, without a route actor or adapter.
    if (board.value.realm_id) {
      const identity = { route: route(board.value.realm_id), id: board.value.realm_id };
      const decisions = await accountStandingCheck(dependencies.access, {
        accountId,
        action: 'realm:read',
        target: { ...identity, eligibility: realmReadEligibility(identity) },
        context: { pool: dependencies.pool, deadline: context.deadline },
      });
      if (decisions[identity.id] !== true) return false;
    }
    for (const row of initial.posts) if (!(await check(row))) return false;
    const current = await snapshot(dependencies, threadId, context, (client) => chain(client, threadId, postId));
    if (fingerprint(initial) !== fingerprint(current.value)) return false;
    const finalBoard = await snapshot(dependencies, boardId, context, (client) => point(client, 'board', boardId));
    return !!finalBoard.value && signature(finalBoard.value) === signature(board.value) && (await check(board.value));
  } catch (error) {
    if (error instanceof ContentNotFoundError) return false;
    throw error;
  }
}

export async function readPost(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  postId: PostId,
  context: ReadContext,
  revisionId?: RevisionId,
): Promise<Anchored<PostEntry | null>> {
  // Captured before the first await so the command-response binding survives
  // later deadline hops. Absent on every ordinary read.
  const replayedRevisionId = replayedRevision.getStore();
  if (
    route(postId) !== route(threadId) ||
    (revisionId && route(revisionId) !== route(threadId)) ||
    (replayedRevisionId !== undefined && route(replayedRevisionId) !== route(threadId))
  ) {
    return snapshot(dependencies, threadId, context, async () => null);
  }
  return withRealmDisclosureScope(
    async () =>
      (await disclose(
        dependencies,
        threadId,
        context,
        postId,
        revisionId,
        false,
        replayedRevisionId,
      )) as Anchored<PostEntry | null>,
  );
}

/** Private inventory projection of ordinary source disclosure. This path never
 * requests revision bytes; account ownership does not replace container Access.
 */
export async function readOwnDraftMetadata(
  dependencies: ContentReadDependencies,
  threadId: string,
  postId: string,
  context: ReadContext,
): Promise<Anchored<NativeDraftMetadata | null>> {
  if (routeOf(threadId) === null || routeOf(postId) !== routeOf(threadId)) throw new ContentNotFoundError();
  return withRealmDisclosureScope(
    async () =>
      (await disclose(
        dependencies,
        threadId,
        context,
        postId,
        undefined,
        false,
        undefined,
        undefined,
        false,
        undefined,
        true,
      )) as Anchored<NativeDraftMetadata | null>,
  );
}

async function list(
  dependencies: ContentReadDependencies,
  threadId: string,
  context: ReadContext,
  cursor: string | undefined,
  limit: number,
  postId?: string,
): Promise<Page<PostEntry | RevisionView>> {
  const clock = dependencies.clock ?? (() => new Date());
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Page limit must be 1 to 100');
  const root = postId
    ? await readPost(dependencies, threadId, postId, context)
    : await readThread(dependencies, threadId, context);
  if (!root.value) throw new ContentNotFoundError();
  if (postId && !('revisionId' in root.value)) return { entries: [], anchor: root.anchor, nextCursor: null };
  const binding: CursorBinding = {
    operation: postId ? 'content.revisions' : 'content.posts',
    parameters: {
      threadId,
      postId: postId ?? null,
      viewer: context.actor.kind === 'account' ? context.actor.accountId : null,
    },
  };
  let after: Key | null = null;
  if (cursor !== undefined) {
    const decoded = decodeCursor(dependencies.tokens, binding, cursor, clock().getTime());
    if (
      !decoded.ok ||
      decoded.epoch !== root.anchor.epoch ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' ||
      typeof decoded.after[1] !== 'string'
    )
      throw new TypeError('Invalid content cursor');
    after = { at: decoded.after[0], id: decoded.after[1] };
  }
  const entries: (PostEntry | RevisionView)[] = [];
  let scanned = 0;
  let more = false;
  while (scanned < 200 && entries.length < limit) {
    const remaining = Math.min(limit - entries.length, 200 - scanned);
    const selected = await snapshot(dependencies, threadId, context, (client) =>
      postId
        ? pageRevisionCandidates(client, { postId, after, limit: remaining })
        : pagePostCandidates(client, { threadId, after, limit: remaining }),
    );
    more = selected.value.nextKey !== null;
    for (const key of selected.value.candidates) {
      after = key;
      scanned++;
      const result = postId
        ? await readPost(dependencies, threadId, postId, context, key.id)
        : await withRealmDisclosureScope(
            async () =>
              (await disclose(
                dependencies,
                threadId,
                context,
                key.id,
                undefined,
                false,
                undefined,
                undefined,
                true,
              )) as Anchored<PostEntry | null>,
          );
      if (!result.value) continue;
      if (postId) {
        if (!('revisionId' in result.value) || result.value.availability === 'withheld') continue;
        const {
          revisionId,
          id,
          parentId: _parentId,
          visibility: _visibility,
          securityRevision: _securityRevision,
          ...value
        } = result.value;
        entries.push({ ...value, id: revisionId, itemId: id, createdAt: key.at });
      } else entries.push(result.value);
    }
    if (!more) break;
  }
  // Recheck the root after hydration; concealed and missing roots share absence.
  const final = postId
    ? await readPost(dependencies, threadId, postId, context)
    : await readThread(dependencies, threadId, context);
  if (!final.value) throw new ContentNotFoundError();
  if (postId && !('revisionId' in final.value)) return { entries: [], anchor: final.anchor, nextCursor: null };
  return {
    entries,
    anchor: final.anchor,
    nextCursor:
      more && after
        ? encodeCursor(
            dependencies.tokens,
            binding,
            { epoch: final.anchor.epoch, after: [after.at, after.id] },
            clock().getTime(),
          )
        : null,
  };
}

export async function listThreadPosts(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  context: ReadContext,
  cursor?: string,
  limit = 100,
): Promise<Page<PostEntry>> {
  return (await list(dependencies, threadId, context, cursor, limit)) as Page<PostEntry>;
}
export async function listPostRevisions(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  postId: PostId,
  context: ReadContext,
  cursor?: string,
  limit = 100,
): Promise<Page<RevisionView>> {
  return (await list(dependencies, threadId, context, cursor, limit, postId)) as Page<RevisionView>;
}

export async function discloseThreads(
  dependencies: ContentReadDependencies,
  threadIds: readonly ThreadId[],
  context: ReadContext,
): Promise<readonly Anchored<ThreadView | null>[]> {
  if (threadIds.length > 200) throw new RangeError('At most 200 disclosure candidates');
  const hint = boardDisclosureHint.getStore();
  if (threadIds.length === 0 && !hint) return [];
  const decisions = hint?.decisions ?? (await prepareBoardPageDecisions(dependencies, context));
  if (hint) {
    const disclosed = await discloseBoardPageThreads(
      dependencies,
      hint.boardId,
      hint.board,
      threadIds,
      hint.expectedRevisions ?? new Map(),
      context,
      decisions,
      hint.query ?? '',
    );
    hint.onFinal?.({ boardAnchor: disclosed.boardAnchor, parentAllowed: disclosed.parentAllowed });
    return disclosed.items;
  }

  // The compatibility caller may supply candidates from more than one board.
  // Discover only their current container keys in one batched snapshot, then
  // disclose each board's complete set in one final snapshot.
  const discovery = await batchSnapshot(dependencies, threadIds, context, async (client) => {
    const rows = await batchRows(
      client,
      'thread',
      threadIds.map((id) => batchKey(id)),
    );
    const boardByThread = new Map<string, string>();
    for (const row of rows) {
      if (row.board_id) boardByThread.set(row.id, row.board_id);
    }
    return boardByThread;
  });
  const groups = new Map<string, string[]>();
  for (const id of threadIds) {
    const boardId = discovery.value.get(id);
    if (!boardId) continue;
    const group = groups.get(boardId) ?? [];
    group.push(id);
    groups.set(boardId, group);
  }
  const results = new Map<string, Anchored<ThreadView | null>>();
  for (const [boardId, ids] of groups) {
    const parent = await readBoardPageCandidateSnapshot(dependencies, boardId, context, decisions, async () => null);
    const anchorFor = (id: string): AnchoredPosition => {
      const partition = discovery.anchors.get(partitionOf(route(id)))!;
      return { partition, epoch: partition.epoch, position: partition.position };
    };
    if (!parent) {
      for (const id of ids) results.set(id, { value: null, anchor: anchorFor(id) });
      continue;
    }
    const disclosed = await discloseBoardPageThreads(
      dependencies,
      boardId,
      parent.board,
      ids,
      new Map(),
      context,
      decisions,
    );
    ids.forEach((id, index) => results.set(id, disclosed.items[index]!));
  }
  return threadIds.map((id) => {
    const known = results.get(id);
    if (known) return known;
    const partition = discovery.anchors.get(partitionOf(route(id)))!;
    return { value: null, anchor: { partition, epoch: partition.epoch, position: partition.position } };
  });
}

/** Exact native rules reader. It shares the ordinary row, ancestry and Access
 * formula; the immutable requested revision never becomes the current head. */
export async function readExactPublishedRules(
  dependencies: Pick<ContentReadDependencies, 'pool' | 'access' | 'clock'>,
  references: readonly (import('./community-presentation-rules.ts').RulesReference & { realmId: string })[],
  context: ReadContext,
): Promise<ReadonlyMap<string, import('./community-presentation-rules.ts').PresentedRules>> {
  if (references.length > 100) throw new RangeError('At most 100 rules references');
  const refs = [...new Map(references.map((ref) => [`${ref.postId}/${ref.revisionId}/${ref.realmId}`, ref])).values()];
  if (!refs.length) return new Map();
  const decisions = await prepareReadDecisions(dependencies.access, {
    actor: context.actor,
    actions: new Set(['thread:read', 'post:read', 'board:read', 'realm:read']),
    context: { pool: dependencies.pool, deadline: context.deadline },
  });
  const ids = refs.flatMap((ref) => [ref.postId, ref.revisionId, ref.realmId]);
  const round = () =>
    batchSnapshot(dependencies, ids, context, async (client, anchors) => {
      const posts = new Map<string, Row>();
      let pending = [...new Set(refs.map((ref) => ref.postId))];
      // Existing ordinary ancestry bound: selected post plus at most 32 parents.
      for (let depth = 0; pending.length && depth < 33; depth++) {
        const rows = await batchRows(
          client,
          'post',
          pending.map((id) => batchKey(id)),
        );
        for (const row of rows) posts.set(row.id, row);
        pending = [
          ...new Set(rows.flatMap((row) => (row.parent_id && !posts.has(row.parent_id) ? [row.parent_id] : []))),
        ];
      }
      const threads = await batchRows(
        client,
        'thread',
        [...new Set([...posts.values()].map((row) => row.thread_id!))].map((id) => batchKey(id)),
      );
      const boards = await batchRows(
        client,
        'board',
        [...new Set(threads.map((row) => row.board_id!))].map((id) => batchKey(id)),
      );
      const realms = await batchRealms(client, [
        ...new Set(boards.flatMap((row) => (row.realm_id ? [row.realm_id] : []))),
      ]);
      const extra = [...new Set(boards.map((row) => partitionOf(route(row.id))))].filter((id) => !anchors.has(id));
      const extraPartitions = await readPartitions(client, extra);
      if (extraPartitions.length !== extra.length || extraPartitions.some((p) => p.writeState === 'moved'))
        throw new Error('Rules container partition unavailable');
      const revisions = await batchRows(
        client,
        'revision',
        [...new Set(refs.map((ref) => ref.revisionId))].map((id) => batchKey(id)),
      );
      const parent = await decideBoardAndRealms(client, decisions, context.actor, boards, realms);
      const permitted = new Map<string, boolean>();
      for (const [kind, rows] of [
        ['thread', threads],
        ['post', [...posts.values()]],
      ] as const) {
        for (let start = 0; start < rows.length; start += 100) {
          const chunk = rows.slice(start, start + 100);
          const allowed = await decisions.decide(client, {
            action: `${kind}:read`,
            resourceType: `content.${kind}`,
            ids: chunk.map((row) => row.id),
            eligibility: async () => Object.fromEntries(chunk.map((row) => [row.id, contentFloor(row, false, false)])),
          });
          for (const row of chunk)
            permitted.set(
              row.id,
              row.availability === 'available' && decisionAllowed(row, allowed[row.id], context.actor, false),
            );
        }
      }
      const byThread = new Map(threads.map((row) => [row.id, row]));
      const byBoard = new Map(boards.map((row) => [row.id, row]));
      const byRevision = new Map(revisions.map((row) => [row.id, row]));
      const passed = new Map<string, string>();
      for (const ref of refs) {
        const selected = posts.get(ref.postId);
        const revision = byRevision.get(ref.revisionId);
        const thread = selected && byThread.get(selected.thread_id!);
        const board = thread && byBoard.get(thread.board_id!);
        if (
          !selected ||
          selected.visibility !== 'published' ||
          !revision ||
          !thread ||
          !board ||
          !permitted.get(thread.id) ||
          !parent.boards.get(board.id) ||
          !parent.realms.get(ref.realmId) ||
          board.realm_id !== ref.realmId ||
          revision.parent_id !== selected.id ||
          revision.thread_id !== thread.id ||
          revision.board_id !== board.id ||
          revision.availability !== 'available' ||
          route(ref.revisionId) !== route(selected.id)
        )
          continue;
        const seen = new Set<string>();
        const chainRows: Row[] = [];
        let post: Row | undefined = selected;
        let complete = false;
        while (post && chainRows.length < 33 && !seen.has(post.id)) {
          if (post.thread_id !== thread.id || !permitted.get(post.id)) break;
          seen.add(post.id);
          chainRows.push(post);
          if (post.parent_id === null) {
            complete = true;
            break;
          }
          post = posts.get(post.parent_id);
        }
        if (!complete) continue;
        const realm = realms.find((row) => row.realm_id === ref.realmId)!;
        passed.set(
          `${ref.realmId}/${ref.postId}/${ref.revisionId}`,
          JSON.stringify([
            signature(thread),
            signature(board),
            ...chainRows.map(signature),
            signature(revision),
            realm,
            [...anchors.values(), ...extraPartitions].map((p) => [p.partitionNo, p.epoch]),
          ]),
        );
      }
      return {
        passed,
        clientBodies: await presentationRuleBodies.run(client, {
          keys: JSON.stringify(
            refs
              .filter((ref) => passed.has(`${ref.realmId}/${ref.postId}/${ref.revisionId}`))
              .map((ref) => ({ route: route(ref.revisionId), id: ref.revisionId })),
          ),
        }),
      };
    });
  const initial = await round();
  const final = await round();
  const output = new Map<string, import('./community-presentation-rules.ts').PresentedRules>();
  for (const row of final.value.clientBodies) {
    if (!row.body || !row.body_sha256) continue;
    const body = parseStoredDocument(Buffer.from(row.body).toString('utf8'));
    if (!body || body.profile !== 'text' || !isSpdxLicense(row.licence)) continue;
    const canonical = serializeDocument(body);
    const digest = createHash('sha256').update(canonical).digest('hex');
    if (Buffer.byteLength(canonical) > 65536 || digest !== Buffer.from(row.body_sha256).toString('hex')) continue;
    for (const ref of refs) {
      if (ref.postId !== row.post_id || ref.revisionId !== row.revision_id) continue;
      const key = `${ref.realmId}/${ref.postId}/${ref.revisionId}`;
      if (initial.value.passed.has(key) && initial.value.passed.get(key) === final.value.passed.get(key))
        output.set(key, {
          postId: row.post_id,
          revisionId: row.revision_id,
          body,
          licence: row.licence,
          sha256: digest,
        });
    }
  }
  return output;
}

export type NoticePostReference = Readonly<{ threadId: string; postId: string | null }>;
export type NoticePostContext = Readonly<{
  threadId: string;
  postId: string | null;
  boardId: string;
  threadTitle: string | null;
  boardTitle: string | null;
}>;

/** Current header-only disclosure for one bounded Inbox candidate page.
 * Target keys are processed by native partition. Bodies and revisions are not read. */
export async function readNoticePostContexts(
  dependencies: ContentReadDependencies,
  references: readonly NoticePostReference[],
  context: ReadContext,
): Promise<ReadonlyMap<string, NoticePostContext>> {
  if (references.length > 200) throw new RangeError('At most 200 notice post references');
  const unique = [
    ...new Map(
      references
        .filter(
          (ref) =>
            routeOf(ref.threadId) !== null &&
            (ref.postId === null || routeOf(ref.postId) !== null) &&
            (ref.postId === null || routeOf(ref.threadId) === routeOf(ref.postId)),
        )
        .map((ref) => [`${ref.threadId}/${ref.postId ?? ''}`, ref] as const),
    ).values(),
  ];
  const partitions = new Map<number, NoticePostReference[]>();
  for (const reference of unique) {
    const partition = partitionOf(route(reference.threadId));
    const rows = partitions.get(partition) ?? [];
    rows.push(reference);
    partitions.set(partition, rows);
  }

  async function rowsInPartitions(client: AccessClient, kind: Kind, keys: readonly BatchKey[]): Promise<Row[]> {
    const groups = new Map<number, BatchKey[]>();
    for (const key of keys) {
      const partition = partitionOf(key.route);
      const rows = groups.get(partition) ?? [];
      rows.push(key);
      groups.set(partition, rows);
    }
    const rows: Row[] = [];
    for (const group of groups.values()) rows.push(...(await batchRows(client, kind, group)));
    return rows;
  }

  async function realmsInPartitions(client: AccessClient, ids: readonly string[]): Promise<RealmBatchRow[]> {
    const groups = new Map<number, string[]>();
    for (const id of new Set(ids)) {
      const routeValue = routeOf(id);
      if (routeValue === null) continue;
      const partition = partitionOf(routeValue);
      const rows = groups.get(partition) ?? [];
      rows.push(id);
      groups.set(partition, rows);
    }
    const rows: RealmBatchRow[] = [];
    for (const group of groups.values()) rows.push(...(await batchRealms(client, group)));
    return rows;
  }

  const output = new Map<string, NoticePostContext>();
  for (const referencesInPartition of partitions.values()) {
    for (let offset = 0; offset < referencesInPartition.length; offset += 100) {
      const chunk = referencesInPartition.slice(offset, offset + 100);
      const ids = [...new Set(chunk.flatMap((ref) => [ref.threadId, ...(ref.postId ? [ref.postId] : [])]))];
      const round = async () => {
        const decisions = await prepareBoardPageDecisions(dependencies, context);
        return batchSnapshot({ pool: dependencies.pool }, ids, context, async (client, anchors) => {
          const posts = new Map<string, Row>();
          let pending = [...new Set(chunk.flatMap((ref) => (ref.postId ? [ref.postId] : [])))];
          for (let depth = 0; pending.length > 0 && depth < 33; depth++) {
            const rows = await rowsInPartitions(
              client,
              'post',
              pending.filter((id) => routeOf(id) !== null).map((id) => batchKey(id)),
            );
            for (const row of rows) posts.set(row.id, row);
            pending = [
              ...new Set(
                rows.flatMap((row) =>
                  row.parent_id && routeOf(row.parent_id) === routeOf(row.id) && !posts.has(row.parent_id)
                    ? [row.parent_id]
                    : [],
                ),
              ),
            ];
          }
          const threadIds = [...new Set(chunk.map((ref) => ref.threadId))];
          const threads = await rowsInPartitions(
            client,
            'thread',
            threadIds.map((id) => batchKey(id)),
          );
          const threadById = new Map(threads.map((row) => [row.id, row]));
          const boardIds = [...new Set(threads.flatMap((row) => (row.board_id ? [row.board_id] : [])))];
          const boards = await rowsInPartitions(
            client,
            'board',
            boardIds.map((id) => batchKey(id)),
          );
          const boardById = new Map(boards.map((row) => [row.id, row]));
          const realmIds = [...new Set(boards.flatMap((row) => (row.realm_id ? [row.realm_id] : [])))];
          const realms = await realmsInPartitions(client, realmIds);
          const extra = [...new Set([...boardIds, ...realmIds].map((id) => partitionOf(route(id))))].filter(
            (partition) => !anchors.has(partition),
          );
          const extraPartitions = await readPartitions(client, extra);
          if (extraPartitions.length !== extra.length) {
            const found = new Set(extraPartitions.map((partition) => partition.partitionNo));
            const missing = extra.find((partition) => !found.has(partition));
            throw new CommandUnavailableError('deadline', missing ?? extra[0]!);
          }
          const moved = extraPartitions.find((partition) => partition.writeState === 'moved');
          if (moved) throw new CommandUnavailableError('moved', moved.partitionNo, moved.movedTo);

          const parent = await decideBoardAndRealms(client, decisions, context.actor, boards, realms);
          const permitted = new Map<string, boolean>();
          for (const [kind, values] of [
            ['thread', threads],
            ['post', [...posts.values()]],
          ] as const) {
            const byId = new Map(values.map((row) => [row.id, row]));
            const uniqueRows = [...byId.values()];
            for (let start = 0; start < uniqueRows.length; start += 100) {
              const batch = uniqueRows.slice(start, start + 100);
              const allowed = await decisions.decide(client, {
                action: `${kind}:read`,
                resourceType: `content.${kind}`,
                ids: batch.map((row) => row.id),
                eligibility: async () =>
                  Object.fromEntries(batch.map((row) => [row.id, contentFloor(row, false, false)])),
              });
              for (const row of batch)
                permitted.set(
                  row.id,
                  row.availability === 'available' && decisionAllowed(row, allowed[row.id], context.actor, false),
                );
            }
          }

          const contexts = new Map<string, { value: NoticePostContext; witness: string }>();
          for (const reference of chunk) {
            const post = reference.postId === null ? null : posts.get(reference.postId);
            const thread = threadById.get(reference.threadId);
            const board = thread?.board_id ? boardById.get(thread.board_id) : undefined;
            if (
              !thread ||
              !board ||
              !permitted.get(thread.id) ||
              !parent.boards.get(board.id) ||
              (board.realm_id !== null && !parent.realms.get(board.realm_id))
            )
              continue;
            const chain: Row[] = [];
            const seen = new Set<string>();
            if (post) {
              if (post.thread_id !== reference.threadId) continue;
              let current: Row | undefined = post;
              let complete = false;
              while (current && chain.length < 33 && !seen.has(current.id)) {
                if (current.thread_id !== thread.id || !permitted.get(current.id)) break;
                seen.add(current.id);
                chain.push(current);
                if (current.parent_id === null) {
                  complete = true;
                  break;
                }
                current = posts.get(current.parent_id);
              }
              if (!complete) continue;
              if (chain.at(-1)?.id !== thread.first_post_id) continue;
            }
            const realm = board.realm_id ? (realms.find((row) => row.realm_id === board.realm_id) ?? null) : null;
            const value = {
              threadId: thread.id,
              postId: post?.id ?? null,
              boardId: board.id,
              threadTitle: thread.title,
              boardTitle: board.title,
            } satisfies NoticePostContext;
            const witness = JSON.stringify([
              signature(thread),
              thread.title,
              signature(board),
              board.title,
              ...chain.map(signature),
              realm,
              [...anchors.values(), ...extraPartitions].map((partition) => [partition.partitionNo, partition.epoch]),
            ]);
            contexts.set(`${reference.threadId}/${reference.postId ?? ''}`, { value, witness });
          }
          return contexts;
        });
      };

      const initial = await round();
      const final = await round();
      for (const reference of chunk) {
        const key = `${reference.threadId}/${reference.postId ?? ''}`;
        const before = initial.value.get(key);
        const after = final.value.get(key);
        if (before && after && before.witness === after.witness) output.set(key, after.value);
      }
    }
  }
  return output;
}

export type NoticeBoardContext = Readonly<{ boardId: string; boardTitle: string | null }>;

/** Current header-only disclosure for report outcomes that target a board. */
export async function readNoticeBoardContexts(
  dependencies: ContentReadDependencies,
  boardIds: readonly string[],
  context: ReadContext,
): Promise<ReadonlyMap<string, NoticeBoardContext>> {
  if (boardIds.length > 200) throw new RangeError('At most 200 notice board references');
  const groups = new Map<number, string[]>();
  for (const id of new Set(boardIds)) {
    const routeValue = routeOf(id);
    if (routeValue === null) continue;
    const partition = partitionOf(routeValue);
    const ids = groups.get(partition) ?? [];
    ids.push(id);
    groups.set(partition, ids);
  }
  const output = new Map<string, NoticeBoardContext>();
  for (const idsInPartition of groups.values()) {
    for (let offset = 0; offset < idsInPartition.length; offset += 100) {
      const ids = idsInPartition.slice(offset, offset + 100);
      const round = async () => {
        const decisions = await prepareBoardPageDecisions(dependencies, context);
        return batchSnapshot({ pool: dependencies.pool }, ids, context, async (client, anchors) => {
          const boards = await batchRows(
            client,
            'board',
            ids.map((id) => batchKey(id)),
          );
          const realmIds = [...new Set(boards.flatMap((board) => (board.realm_id ? [board.realm_id] : [])))];
          const realms = await batchRealms(client, realmIds);
          const extra = [...new Set(realmIds.map((id) => partitionOf(route(id))))].filter(
            (partition) => !anchors.has(partition),
          );
          const extraPartitions = await readPartitions(client, extra);
          if (extraPartitions.length !== extra.length) {
            const found = new Set(extraPartitions.map((partition) => partition.partitionNo));
            const missing = extra.find((partition) => !found.has(partition));
            throw new CommandUnavailableError('deadline', missing ?? extra[0]!);
          }
          const moved = extraPartitions.find((partition) => partition.writeState === 'moved');
          if (moved) throw new CommandUnavailableError('moved', moved.partitionNo, moved.movedTo);
          const parent = await decideBoardAndRealms(client, decisions, context.actor, boards, realms);
          const allowed =
            boards.length === 0
              ? {}
              : await decisions.decide(client, {
                  action: 'board:read',
                  resourceType: 'content.board',
                  ids: boards.map((board) => board.id),
                  eligibility: async () =>
                    Object.fromEntries(boards.map((board) => [board.id, contentFloor(board, false, false)])),
                });
          const result = new Map<string, { value: NoticeBoardContext; witness: string }>();
          for (const board of boards) {
            if (
              !decisionAllowed(board, allowed[board.id], context.actor, false) ||
              !parent.boards.get(board.id) ||
              (board.realm_id !== null && !parent.realms.get(board.realm_id))
            )
              continue;
            const realm = board.realm_id ? (realms.find((row) => row.realm_id === board.realm_id) ?? null) : null;
            result.set(board.id, {
              value: { boardId: board.id, boardTitle: board.title },
              witness: JSON.stringify([
                signature(board),
                board.title,
                realm,
                [...anchors.values(), ...extraPartitions].map((partition) => [partition.partitionNo, partition.epoch]),
              ]),
            });
          }
          return result;
        });
      };
      const initial = await round();
      const final = await round();
      for (const id of ids) {
        const before = initial.value.get(id);
        const after = final.value.get(id);
        if (before && after && before.witness === after.witness) output.set(id, after.value);
      }
    }
  }
  return output;
}

/** Current bounded board response composition. The native internal reader stays
 * independent, so exact post/rules reads cannot recurse into presentation. */
export async function readBoards(
  dependencies: ContentReadDependencies,
  boardIds: readonly string[],
  context: ReadContext,
): Promise<readonly Anchored<import('./model.ts').BoardView | null>[]> {
  if (boardIds.length > 100) throw new RangeError('At most 100 board identities');
  if (!boardIds.length) return [];
  const ids = [...new Set(boardIds)];
  const decisions = await prepareBoardPageDecisions(dependencies, context);
  const round = () =>
    batchSnapshot(dependencies, ids, context, async (client) => {
      const boards = await batchRows(
        client,
        'board',
        ids.map((id) => batchKey(id)),
      );
      const realms = await batchRealms(
        client,
        boards.flatMap((row) => (row.realm_id ? [row.realm_id] : [])),
      );
      const checked = await decideBoardAndRealms(client, decisions, context.actor, boards, realms);
      return new Map(
        boards
          .filter((row) => checked.boards.get(row.id) && (!row.realm_id || checked.realms.get(row.realm_id)))
          .map((row) => [row.id, row]),
      );
    });
  const initial = await round();
  const presentations = await readCommunityPresentations(
    dependencies,
    [...new Set([...initial.value.values()].flatMap((row) => (row.realm_id ? [row.realm_id] : [])))],
    context,
  );
  const final = await round();
  return boardIds.map((id) => {
    const row = final.value.get(id);
    const partition = final.anchors.get(partitionOf(route(id)))!;
    const before = initial.value.get(id);
    const anchor = { partition, epoch: partition.epoch, position: partition.position };
    if (
      !row ||
      !before ||
      signature(row) !== signature(before) ||
      initial.anchors.get(partition.partitionNo)?.epoch !== partition.epoch
    )
      return { anchor, value: null };
    const community = row.realm_id ? presentations.get(row.realm_id) : null;
    if (row.realm_id && !community) return { anchor, value: null };
    return { anchor, value: { ...boardView(row), community: community ?? null } };
  });
}

/** Edition publication enrolls just the selected source post. Ancestors keep their
 * ordinary read formula; this port cannot authorize an ordinary post route. */
export function prepareEditionSource(
  dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>,
  source: ContentEditionSource,
  context: ReadContext,
  time: AuthoritativeTime,
  accessContext: AccessContext,
  ordinarySource: boolean,
) {
  return prepareEditionSourceAuthority(dependencies, source, time, accessContext, ordinarySource, (action, anchor) =>
    accessCheck(dependencies.access, context.actor, action, anchor.resource, accessContext),
  );
}

/** Native publisher checks restore separately for every action and exact resource.
 * This never creates a workflow ReadContext or supplies a buyer identity. */
export function prepareEditionPublisherSource(
  dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>,
  source: ContentEditionSource,
  operation: DurableOperationAnchor,
  restorer: InitiatorRestorer,
  time: AuthoritativeTime,
  accessContext: AccessContext,
) {
  return prepareEditionSourceAuthority(dependencies, source, time, accessContext, true, async (action, anchor) => {
    try {
      const actor = await restorer.restoreInitiator({ operation, action, anchor, context: accessContext }, time);
      if (actor.accountId !== source.creatorAccountId) throw new AccessUnavailableError('overloaded');
      const publisherContext = commandAccessContext(accessContext, {
        time,
        partition: partitionOf(anchor.resource.route),
        basis: {
          actorAccountId: actor.accountId,
          clientId: actor.clientId,
          requestedBy: actor.requestedBy,
        },
      });
      return accessCheck(dependencies.access, actor, action, anchor.resource, publisherContext);
    } catch (error) {
      if (error instanceof DurableInitiatorUnavailableError) throw new AccessUnavailableError('overloaded');
      throw error;
    }
  });
}

async function prepareEditionSourceAuthority(
  dependencies: Pick<ContentReadDependencies, 'pool' | 'access'>,
  source: ContentEditionSource,
  time: AuthoritativeTime,
  accessContext: AccessContext,
  ordinarySource: boolean,
  authorize: EditionSourceAuthorization,
): Promise<Readonly<{
  check(client: AccessClient): Promise<boolean>;
  final(): Promise<boolean>;
}> | null> {
  const context = accessContext;
  const subject = await prepareEditionSubject(dependencies, source.targetSubjectId, time, accessContext, authorize);
  if (!subject) return null;
  const live = (value: Chain | null): value is Chain =>
    !!value &&
    !!value.revision &&
    value.revision.id === source.revisionId &&
    value.revision.parent_id === source.postId &&
    value.revision.availability === 'available' &&
    value.revision.subject_ids.includes(source.targetSubjectId) &&
    value.revision.sha256?.toString('hex') === source.sha256 &&
    value.revision.licence === source.licence &&
    value.posts[0]?.author_id === source.creatorAccountId &&
    [value.thread, ...value.posts].every(
      (row) => row.availability === 'available' && ['published', 'protected'].includes(row.visibility),
    );
  const observed = await snapshot(dependencies, source.threadId, context, (client) =>
    chain(client, source.threadId, source.postId, source.revisionId),
  );
  const initial = observed.value;
  if (!live(initial) || !initial.thread.board_id) return null;
  const boardId = initial.thread.board_id;
  const board = (await snapshot(dependencies, boardId, context, (client) => point(client, 'board', boardId))).value;
  if (!board || board.availability !== 'available' || !['published', 'protected'].includes(board.visibility))
    return null;
  const boardValid = async (client: AccessClient) => {
    const current = await point(client, 'board', boardId);
    return !!current && signature(current) === signature(board);
  };
  const boardCheck = await authorize('board:read', {
    resource: readResource(board, board),
    validate: boardValid,
  });
  const boardAllowed = async () =>
    (
      await snapshot(
        dependencies,
        boardId,
        context,
        async (client) => (await boardValid(client)) && (await boardCheck(client, time)),
      )
    ).value;
  if (!(await boardAllowed())) return null;
  const realmId = board.realm_id;
  const parent = realmId
    ? (
        await snapshot(
          dependencies,
          realmId,
          context,
          async (client) =>
            (
              await client.query<{ space_id: string; head_revision_id: string }>(
                `SELECT r.space_id,r.head_revision_id FROM community.realm r
       JOIN community.space s ON s.route=r.route AND s.space_id=r.space_id
       WHERE r.route=$1 AND r.realm_id=$2 AND r.state='active' AND s.state='active'
         AND r.created_at <= $3::timestamptz AND s.created_at <= $3::timestamptz`,
                [route(realmId), realmId, authoritativeTimeValue(time)],
              )
            ).rows[0] ?? null,
        )
      ).value
    : null;
  if (realmId && !parent) return null;
  const realmResource = realmId
    ? {
        route: route(realmId),
        id: realmId,
        eligibility: realmReadEligibility({ route: route(realmId), id: realmId }),
      }
    : null;
  const spaceResource = parent
    ? {
        route: route(parent.space_id),
        id: parent.space_id,
        eligibility: spaceReadEligibility({ route: route(parent.space_id), id: parent.space_id }),
      }
    : null;
  const realmValid = async (client: AccessClient) => {
    const current = (
      await client.query<{ space_id: string; head_revision_id: string }>(
        `SELECT space_id,head_revision_id FROM community.realm
       WHERE route=$1 AND realm_id=$2 AND state='active' AND created_at <= $3::timestamptz`,
        [route(realmId!), realmId, authoritativeTimeValue(time)],
      )
    ).rows[0];
    return !!current && current.space_id === parent!.space_id && current.head_revision_id === parent!.head_revision_id;
  };
  const spaceValid = async (client: AccessClient) =>
    (
      await client.query(
        `SELECT space_id FROM community.space WHERE route=$1 AND space_id=$2 AND state='active'
       AND created_at <= $3::timestamptz`,
        [route(parent!.space_id), parent!.space_id, authoritativeTimeValue(time)],
      )
    ).rows.length === 1;
  const realmCheck = realmResource
    ? await authorize('realm:read', { resource: realmResource, validate: realmValid })
    : null;
  const spaceCheck = spaceResource
    ? await authorize('space:read', { resource: spaceResource, validate: spaceValid })
    : null;
  const realmAllowed = async () =>
    !realmId ||
    (
      await snapshot(dependencies, realmId, context, async (client) => {
        const current = (
          await client.query<{ space_id: string; head_revision_id: string }>(
            `SELECT r.space_id,r.head_revision_id FROM community.realm r
         JOIN community.space s ON s.route=r.route AND s.space_id=r.space_id
         WHERE r.route=$1 AND r.realm_id=$2 AND r.state='active' AND s.state='active'`,
            [route(realmId), realmId],
          )
        ).rows[0];
        return (
          !!current &&
          current.space_id === parent!.space_id &&
          current.head_revision_id === parent!.head_revision_id &&
          (await realmCheck!(client, time)) &&
          (await spaceCheck!(client, time))
        );
      })
    ).value;
  // Native pending erasure is checked at the creator's independently anchored home.
  const fenceOpen = async () =>
    (
      await snapshot(dependencies, source.creatorAccountId, context, async (client) => {
        const result = await client.query<{ open: boolean }>(
          `SELECT a.state='active' AND NOT EXISTS (
         SELECT 1 FROM content.erasure_fence f WHERE f.route=a.route AND f.account_id=a.account_id
         AND f.closed_at IS NOT NULL) AS open
       FROM access.account a WHERE a.route=$1 AND a.account_id=$2`,
          [route(source.creatorAccountId), source.creatorAccountId],
        );
        return result.rows[0]?.open === true;
      })
    ).value;
  if (!(await realmAllowed()) || !(await fenceOpen())) return null;
  const rows = [initial.thread, ...initial.posts.filter((row, index) => ordinarySource || index > 0)];
  const checks: AccessCheck[] = [];
  for (const row of rows)
    checks.push(
      await authorize(`${row.kind}:read`, {
        resource: readResource(row, observed),
        async validate(client) {
          const current = await point(client, row.kind, row.id, row.thread_id ?? row.id);
          return !!current && signature(current) === signature(row);
        },
      }),
    );
  const check = async (client: AccessClient): Promise<boolean> => {
    const current = await chain(client, source.threadId, source.postId, source.revisionId);
    if (!live(current) || fingerprint(current) !== fingerprint(initial)) return false;
    for (const check of checks) if (!(await check(client, time))) return false;
    return true;
  };
  return {
    check,
    async final() {
      if (!(await subject.final()) || !(await boardAllowed()) || !(await realmAllowed()) || !(await fenceOpen()))
        return false;
      return (await snapshot(dependencies, source.threadId, context, check)).value;
    },
  };
}
