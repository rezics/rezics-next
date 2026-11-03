import { communityReportReadCheck, communityReportTargetFacts } from '../community/report-targets.ts';
import { ProblemError } from '../http/problem.ts';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { createResourceAnonymousEligibility } from '../access/eligibility.ts';
import { commandAccessContext } from '../access/command-admission.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import {
  authoritativeTimeValue,
  CommandUnavailableError,
  normalizeCommandKey,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandOutcome,
  type CommandPrincipal,
  type PrincipalCommandOptions,
  type PrincipalCommandReceipt,
} from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readAccount } from '../access/account-data.ts';
import { anonymousCommandTarget, anonymousRequestDigest, requestDigest } from '../http/request.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient, type AccessCheck, type Actor } from '../request/access.ts';
import { anchorRoute, derivedId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { globalContextAnchor } from '../semantic/context.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { readSubjectReference } from '../semantic/references.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import subjectFacts from './read-report-subject.sql';
import cataloguePage from './catalogue-report-page.sql';
import catalogueKindPage from './report-catalogue-kind-page.sql';
import insert from './insert-report.sql';
import page from './page-target-reports.sql';
import boardPage from './board-report-page.sql';
import { reportBoardPlacement } from './board-report-candidates.ts';
import read from './read-report.sql';
import readReportBoard from './read-report-board.sql';
import readReportPost from './read-report-post.sql';
import readReportPostThread from './read-report-post-thread.sql';
import readReportRevision from './read-report-revision.sql';
import readReportThread from './read-report-thread.sql';
import { readBoard, readPost, readThread } from './reads.ts';
import type { TurnstileVerifier } from './turnstile.ts';
import type { Anchored, BoardId, Page, PostId, ReportId, RequestContext, RevisionId, ThreadId } from './model.ts';

export type ReportTarget =
  | Readonly<{ kind: 'board'; id: BoardId }>
  | Readonly<{ kind: 'thread'; id: ThreadId }>
  | Readonly<{ kind: 'post'; id: PostId }>
  | Readonly<{ kind: 'subject'; id: string }>
  | Readonly<{ kind: 'space'; id: string }>
  | Readonly<{ kind: 'realm'; id: string }>;
type ReportScope = ReportTarget | Readonly<{ kind: 'catalogue'; id: string }>;
export const CATALOGUE_REPORT_PAGE_LIMIT = 50;
// Four independently current inspections per candidate, each with Global and Subject snapshots, plus report fill.
export const SUBJECT_REPORT_INSPECTIONS_PER_CANDIDATE = 4;
export const CATALOGUE_REPORT_SNAPSHOT_CEILING =
  3 + CATALOGUE_REPORT_PAGE_LIMIT * (2 * SUBJECT_REPORT_INSPECTIONS_PER_CANDIDATE + 1);
export type ReportSelection = Readonly<{
  status?: 'all' | 'pending' | 'resolved';
  targetKind?: 'all' | ReportTarget['kind'];
  order?: 'newest' | 'oldest';
}>;
export type ReportInput = Readonly<{
  target: ReportTarget;
  revisionId?: RevisionId;
  reason: string;
  evidence?: string;
}>;
export type ReportView = Readonly<{
  id: ReportId;
  partition: number;
  target: ReportTarget;
  revisionId: RevisionId | null;
  reason: string;
  evidence: string | null;
  createdAt: string;
  outcome: 'actioned' | 'dismissed' | null;
  resolvedAt: string | null;
  transactionId: string;
  reporterId: string | null;
}>;
/** The reporter's submitted record, without moderator-only storage metadata. */
export type ReporterReportView = Pick<
  ReportView,
  'id' | 'target' | 'revisionId' | 'reason' | 'evidence' | 'reporterId' | 'createdAt' | 'outcome' | 'resolvedAt'
> &
  Readonly<{ targetAvailability: 'available' | 'unavailable' }>;
export type ReportReadView = ReportView | ReporterReportView;
export type ReportDependencies = Readonly<{
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  clock?: () => Date;
  anonymousVerifier?: TurnstileVerifier;
}>;
/** Ephemeral admission credential. Implementations must verify it once and never persist it. */
export type ReportRequestContext = RequestContext & Readonly<{ botToken?: string }>;
const operation = 'content.report.create';
const createAction = 'report:create';
const inspectAction = 'moderation:read_reports';
const reasons = new Set(['off_topic', 'inappropriate', 'spam', 'illegal', 'other']);
type ReadContext = Readonly<{ actor: Actor; deadline: number }>;
type ReportRow = {
  route: number;
  report_id: string;
  target_kind: ReportTarget['kind'];
  target_id: string;
  revision_id: string | null;
  reason: string | null;
  evidence: string | null;
  reporter_account_id: string | null;
  recorded_transaction_id: string;
  created_at: string;
  outcome: 'actioned' | 'dismissed' | null;
  resolved_at: string | null;
};
type TargetFacts = {
  fingerprint: string;
  threadId?: string;
  firstPostId?: string;
};

export class ReportUnavailableError extends Error {
  constructor() {
    super('Report is unavailable');
    this.name = 'ReportUnavailableError';
  }
}

export class ReportProofRequiredError extends Error {
  constructor() {
    super('A valid Turnstile proof is required');
    this.name = 'ReportProofRequiredError';
  }
}

export class ReportProofUnavailableError extends Error {
  constructor() {
    super('Turnstile proof verification is unavailable');
    this.name = 'ReportProofUnavailableError';
  }
}

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Invalid routed identity');
  return value;
}

function validateTarget(target: ReportTarget): void {
  if (!target || !['board', 'thread', 'post', 'subject', 'space', 'realm'].includes(target.kind))
    throw new TypeError('Invalid report target');
  route(target.id);
}

/** Cursor signing has a separate domain from stable report-home derivation. */
function tokens(dependencies: ReportDependencies): KeyRing {
  if (dependencies.routeKey.byteLength < 32) throw new RangeError('Report route key must contain at least 32 bytes');
  return {
    current: 1,
    keys: new Map([[1, createHmac('sha256', dependencies.routeKey).update('content.report.cursor.v1').digest()]]),
  };
}

async function snapshot<T>(
  dependencies: Pick<ReportDependencies, 'pool'>,
  id: string,
  deadline: number,
  work: (client: AccessClient) => Promise<T>,
): Promise<Anchored<T>> {
  return within(deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partitionNo = partitionOf(route(id));
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        const value = await work(client);
        await client.query('COMMIT');
        return { value, anchor: { partition, epoch: partition.epoch, position: partition.position } };
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

/** Security fences only, without loading revision bodies. All probes include the
 * exact route and ID. Missing ancestry, cycles and depth overflow fail closed. */
async function targetFacts(client: AccessClient, target: ReportTarget): Promise<TargetFacts | null> {
  const home = route(target.id);
  if (target.kind === 'space' || target.kind === 'realm') return communityReportTargetFacts(client, target);
  if (target.kind === 'subject') {
    const subject = await subjectFacts.run(client, { route: home, subject_id: target.id });
    return subject ? { fingerprint: JSON.stringify(subject) } : null;
  }
  if (target.kind === 'board') {
    const board = await readReportBoard.run(client, { route: home, id: target.id });
    return board ? { fingerprint: JSON.stringify(board) } : null;
  }
  let threadId = target.id;
  if (target.kind === 'post') {
    const located = await readReportPostThread.run(client, { route: home, id: target.id });
    if (!located || route(located.thread_id) !== home) return null;
    threadId = located.thread_id;
  }
  const thread = await readReportThread.run(client, { route: home, id: threadId });
  if (!thread?.first_post_id) return null;
  const fences: unknown[] = [thread];
  let postId: string | null = target.kind === 'post' ? target.id : thread.first_post_id;
  const seen = new Set<string>();
  while (postId) {
    if (route(postId) !== home || seen.has(postId) || seen.size >= 33) return null;
    seen.add(postId);
    const post = await readReportPost.run(client, { route: home, id: postId, thread_id: threadId });
    if (!post) return null;
    fences.push(post);
    postId = post.reply_to_post_id;
  }
  return { fingerprint: JSON.stringify(fences), threadId, firstPostId: thread.first_post_id };
}

/** Use the actual disclosure driver; neither a publication flag nor authorship
 * substitutes for its container chain and shared Access decisions. */
async function discloseTarget(
  dependencies: ReportDependencies,
  target: ReportTarget,
  context: ReadContext,
): Promise<TargetFacts> {
  const initial = await snapshot(dependencies, target.id, context.deadline, (client) => targetFacts(client, target));
  const facts = initial.value;
  if (!facts) throw new ReportUnavailableError();
  if (target.kind === 'space' || target.kind === 'realm') {
    if (!(await readableCommunityTarget(dependencies, target, context, facts.fingerprint))) throw new ReportUnavailableError();
    return facts;
  }
  if (target.kind === 'subject') {
    if (!(await readableSubject(dependencies, target.id, context))) throw new ReportUnavailableError();
    return facts;
  }
  const readers = { pool: dependencies.pool, access: dependencies.access, tokens: tokens(dependencies) };
  const disclosed =
    target.kind === 'board'
      ? await readBoard(readers, target.id, context)
      : target.kind === 'thread'
        ? await readThread(readers, target.id, context)
        : await readPost(readers, facts.threadId!, target.id, context);
  if (!disclosed.value) throw new ReportUnavailableError();
  return facts;
}

async function exactRevision(
  client: AccessClient,
  target: ReportTarget,
  facts: TargetFacts,
  revisionId: string | null,
): Promise<boolean> {
  if (!revisionId) return true;
  if (!['thread', 'post'].includes(target.kind) || !facts.threadId || route(revisionId) !== route(target.id))
    return false;
  const revision = await readReportRevision.run(client, {
    route: route(revisionId),
    id: revisionId,
    thread_id: facts.threadId,
  });
  return !!revision && (target.kind === 'thread' || revision.post_id === target.id);
}

export async function createReport(
  dependencies: ReportDependencies,
  actor: Actor,
  input: ReportInput,
  context: ReportRequestContext,
): Promise<CommandOutcome<Readonly<{ reportId: ReportId }>>> {
  validateTarget(input.target);
  if (input.revisionId !== undefined) route(input.revisionId);
  if (
    typeof input.reason !== 'string' ||
    !reasons.has(input.reason) ||
    (input.evidence !== undefined && typeof input.evidence !== 'string') ||
    Buffer.byteLength(input.reason) + Buffer.byteLength(input.evidence ?? '') > 2_097_152 ||
    Array.from(input.evidence ?? '').length > 4096 ||
    (['illegal', 'other'].includes(input.reason) && !input.evidence?.length)
  )
    throw new TypeError('Invalid report evidence');
  // Snapshot caller-owned values before any asynchronous admission work.
  const target: ReportTarget = Object.freeze({ kind: input.target.kind, id: input.target.id });
  const semantic = {
    target,
    revisionId: input.revisionId ?? null,
    reason: input.reason,
    evidence: input.evidence ?? null,
  };
  const identity = principalCommandIdentity(actor);
  const principal: CommandPrincipal = identity.principal;
  const key = normalizeCommandKey(principal, context.idempotencyKey);
  const name = JSON.stringify([principal.kind, principal.id, operation, key]);
  const home =
    actor.kind === 'anonymous'
      ? anonymousCommandTarget(dependencies.routeKey, operation, context.idempotencyKey)
      : (() => {
          const reportRoute = anchorRoute(dependencies.routeKey, name);
          return { route: reportRoute, id: derivedId(principal.id, name, reportRoute) };
        })();
  // Provider proof is verified exactly once per invocation, before the command
  // boundary. A retry needs fresh proof; it never changes the semantic digest.
  let proof: Awaited<ReturnType<TurnstileVerifier['verify']>> | undefined;
  // With no verifier configured an anonymous report fails closed like an
  // ineligible target: no disclosure, no effect, and not a provider outage.
  if (actor.kind === 'anonymous' && !dependencies.anonymousVerifier) throw new ReportUnavailableError();
  if (context.botToken !== undefined && dependencies.anonymousVerifier) {
    try {
      proof = await dependencies.anonymousVerifier.verify(context.botToken, { deadline: context.deadline });
    } catch {
      throw new ReportProofUnavailableError();
    }
    if (!proof.ok && proof.reason === 'unavailable') throw new ReportProofUnavailableError();
  }
  let observed: TargetFacts | undefined;
  if (actor.kind === 'anonymous') {
    // Establish the caller's current disclosure before reporting a proof error.
    // An unreadable target remains concealed, while a readable target can tell
    // the caller that Turnstile proof is missing or invalid.
    observed = await discloseTarget(dependencies, target, { actor, deadline: context.deadline });
    if (proof?.ok !== true) throw new ReportProofRequiredError();
  }
  let validRevision = false;
  let subjectReadCheck: AccessCheck | undefined;
  const resource =
    target.kind === 'subject' ? globalContextAnchor.resource : { route: route(target.id), id: target.id };
  const eligibility = createResourceAnonymousEligibility({
    resource,
    action: createAction,
    async prepare() {
      observed ??= await discloseTarget(dependencies, target, { actor, deadline: context.deadline });
      return observed;
    },
    async verify({ client, evidence }) {
      const current = await targetFacts(client, target);
      if (!current || current.fingerprint !== evidence.fingerprint) throw new ReportUnavailableError();
      return proof?.ok === true;
    },
  });
  const accessAuthorization = resourceAuthorization({
    access: dependencies.access,
    actor,
    action: createAction,
    anchor: {
      resource: { ...resource, eligibility },
      async validate(client, time) {
        if (target.kind === 'subject') {
          if (!(await globalContextAnchor.validate(client, time))) return false;
          if (!subjectReadCheck || !(await subjectReadCheck(client, time))) throw new ReportUnavailableError();
        }
        const partition = await readPartition(client, partitionOf(route(target.id)));
        if (!partition || partition.writeState === 'moved' || !observed) return false;
        const current = await targetFacts(client, target);
        if (!current || current.fingerprint !== observed.fingerprint) {
          if (target.kind === 'space' || target.kind === 'realm') throw new ReportUnavailableError();
          return false;
        }
        // This fact is consumed only by a new command body, AFTER receipt lookup.
        // A changed, nonexistent revision under a reused key must still conflict.
        validRevision = await exactRevision(client, target, current, semantic.revisionId);
        return true;
      },
    },
    context: { pool: dependencies.pool, deadline: context.deadline, partition: partitionOf(home.route) },
  });
  const authorization: CommandAuthorization = {
    ...accessAuthorization,
    async prepare(attempt) {
      // Resolve disclosure inside each live command attempt before report:create
      // authorization can turn an unreadable target into a generic denial.
      observed = await discloseTarget(dependencies, target, { actor, deadline: context.deadline });
      if (target.kind === 'subject') {
        subjectReadCheck = await accessCheck(
          dependencies.access,
          actor,
          'subject:read',
          {
            route: route(target.id),
            id: target.id,
            eligibility: subjectReadEligibility({ route: route(target.id), id: target.id }),
          },
          commandAccessContext({ pool: dependencies.pool, deadline: context.deadline }, attempt),
        );
      }
      const prepared = await accessAuthorization.prepare!(attempt);
      if (target.kind === 'space' || target.kind === 'realm') {
        if (!(await readableCommunityTarget(dependencies, target, { actor, deadline: context.deadline }, observed.fingerprint)))
          throw new ReportUnavailableError();
      }
      return prepared;
    },
  };
  const receipt: PrincipalCommandReceipt = {
    kind: operation,
    key: context.idempotencyKey,
    digest:
      actor.kind === 'anonymous'
        ? anonymousRequestDigest(operation, { semantic })
        : requestDigest(operation, actor, semantic),
  };
  const options: PrincipalCommandOptions = {
    ...identity,
    partition: partitionOf(home.route),
    deadline: context.deadline,
    ...(dependencies.clock ? { clock: dependencies.clock } : {}),
    receipt,
    authorization,
  };
  return runCommand(dependencies.pool, options, async (tx, command) => {
    if (!validRevision) throw new ReportUnavailableError();
    const parameters = {
      route: home.route,
      report_id: home.id,
      target_kind: target.kind,
      target_id: target.id,
      target_witness: target.kind === 'space' || target.kind === 'realm' ? observed!.fingerprint : null,
      revision_id: semantic.revisionId,
      reason: semantic.reason,
      evidence: semantic.evidence,
      reporter_account_id: actor.kind === 'account' ? actor.accountId : null,
      created_at: authoritativeTimeValue(command.time),
      transaction_id: command.transactionId,
    };
    await tx.query(
      insert.sql,
      insert.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    return {
      value: { reportId: home.id },
      events: [
        {
          type: 'com.rezics.content.report.created.v1',
          subject: home.id,
          data: {
            reportId: home.id,
            targetKind: target.kind,
            targetId: target.id,
            ...(semantic.revisionId ? { revisionId: semantic.revisionId } : {}),
          },
        },
      ],
    };
  });
}

/** Native eligibility can conceal missing/removed heads by throwing not_found. Infrastructure failures propagate. */
async function readableCommunityTarget(
  dependencies: ReportDependencies,
  target: Extract<ReportTarget, { kind: 'space' | 'realm' }>,
  context: ReadContext,
  expected?: string,
): Promise<boolean> {
  try {
    const check = await communityReportReadCheck(dependencies, target, context);
    return (await snapshot(dependencies, target.id, context.deadline, async (client) => {
      const facts = await communityReportTargetFacts(client, target);
      return !!facts && (expected === undefined || facts.fingerprint === expected) && (await check(client));
    })).value;
  } catch (error) {
    if (error instanceof ProblemError && error.code === 'not_found') return false;
    throw error;
  }
}

async function readableSubject(dependencies: ReportDependencies, id: string, context: ReadContext): Promise<boolean> {
  const resource = { route: route(id), id, eligibility: subjectReadEligibility({ route: route(id), id }) };
  const check = await accessCheck(dependencies.access, context.actor, 'subject:read', resource, {
    pool: dependencies.pool,
    deadline: context.deadline,
  });
  try {
    return !!(await within(context.deadline, () =>
      readSubjectReference(dependencies.pool, id, (client) => check(deadlineClient(client, context.deadline))),
    ));
  } catch (error) {
    if (error instanceof SubjectRedirectError) return false;
    throw error;
  }
}

async function inspect(dependencies: ReportDependencies, target: ReportScope, context: ReadContext) {
  if (target.kind === 'catalogue') return inspectCatalogue(dependencies, context);
  if (target.kind === 'space' || target.kind === 'realm') {
    if (!(await readableCommunityTarget(dependencies, target, context))) {
      return snapshot(dependencies, target.id, context.deadline, async () => false);
    }
  }
  if (target.kind === 'subject') {
    const subject = await snapshot(
      dependencies,
      target.id,
      context.deadline,
      async (client) => !!(await targetFacts(client, target)),
    );
    const allowed = await inspectCatalogue(dependencies, context);
    return { ...subject, value: subject.value && allowed.value };
  }
  const check =
    context.actor.kind === 'account'
      ? await accessCheck(
          dependencies.access,
          context.actor,
          inspectAction,
          { route: route(target.id), id: target.id },
          { pool: dependencies.pool, deadline: context.deadline },
        )
      : null;
  return snapshot(
    dependencies,
    target.id,
    context.deadline,
    async (client) => !!check && !!(await targetFacts(client, target)) && (await check(client)),
  );
}

async function inspectCatalogue(dependencies: ReportDependencies, context: ReadContext) {
  const check =
    context.actor.kind === 'account'
      ? await accessCheck(dependencies.access, context.actor, inspectAction, globalContextAnchor.resource, {
          pool: dependencies.pool,
          deadline: context.deadline,
        })
      : null;
  return snapshot(
    dependencies,
    GLOBAL_CONTEXT,
    context.deadline,
    async (client) =>
      !!check &&
      !!(
        await client.query('SELECT 1 FROM semantic.context WHERE route = $1 AND context_id = $2 AND kind = $3', [
          0,
          GLOBAL_CONTEXT,
          'global',
        ])
      ).rowCount &&
      (await check(client)),
  );
}

function sameReportReference(left: ReportRow, right: ReportRow): boolean {
  return (
    left.route === right.route &&
    left.report_id === right.report_id &&
    left.target_kind === right.target_kind &&
    left.target_id === right.target_id &&
    left.revision_id === right.revision_id &&
    left.reporter_account_id === right.reporter_account_id &&
    left.recorded_transaction_id === right.recorded_transaction_id &&
    left.created_at === right.created_at &&
    left.outcome === right.outcome &&
    left.resolved_at === right.resolved_at
  );
}

async function reporterCanReadOwnReport(
  dependencies: ReportDependencies,
  actor: Actor,
  reporterAccountId: string,
  context: ReadContext,
): Promise<boolean> {
  if (actor.kind !== 'account' || actor.accountId !== reporterAccountId) return false;
  const accountRoute = route(reporterAccountId);
  const check = await accessCheck(
    dependencies.access,
    actor,
    'account:read',
    { route: accountRoute, id: reporterAccountId },
    { pool: dependencies.pool, deadline: context.deadline },
  );
  return (
    await snapshot(dependencies, reporterAccountId, context.deadline, async (client) => {
      const account = await readAccount(client, accountRoute, reporterAccountId);
      if (
        !account ||
        account.accountId !== actor.accountId ||
        account.kind !== 'actor' ||
        account.state !== 'active' ||
        account.fenced ||
        BigInt(actor.authnEpoch) < account.minimumAuthnEpoch
      )
        return false;
      return check(client);
    })
  ).value;
}

function view(row: ReportRow): ReportView {
  if (row.reason === null) throw new ReportUnavailableError();
  return {
    id: row.report_id,
    partition: partitionOf(row.route),
    target: { kind: row.target_kind, id: row.target_id },
    revisionId: row.revision_id,
    reason: row.reason,
    evidence: row.evidence,
    reporterId: row.reporter_account_id,
    createdAt: row.created_at,
    outcome: row.outcome,
    resolvedAt: row.resolved_at,
    transactionId: row.recorded_transaction_id,
  };
}

async function loadReport(
  dependencies: ReportDependencies,
  reportId: ReportId,
  context: ReadContext,
  includePrivate: boolean,
  ownerAccountId: string | null = null,
): Promise<Anchored<ReportRow | null>> {
  return snapshot(dependencies, reportId, context.deadline, async (client) => {
    const parameters = {
      route: route(reportId),
      report_id: reportId,
      include_private: includePrivate,
      owner_account_id: ownerAccountId,
    };
    const { rows } = await client.query<ReportRow>(
      read.sql,
      read.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    return rows[0] ?? null;
  });
}

/** Native exact reads own current target/container/Realm disclosure. Each checkout
 * is released before the next home is touched; failures propagate to the caller. */
async function targetAvailability(
  dependencies: ReportDependencies,
  target: ReportTarget,
  context: ReadContext,
): Promise<ReporterReportView['targetAvailability']> {
  if (target.kind === 'space' || target.kind === 'realm')
    return (await readableCommunityTarget(dependencies, target, context)) ? 'available' : 'unavailable';
  if (target.kind === 'subject')
    return (await readableSubject(dependencies, target.id, context)) ? 'available' : 'unavailable';
  const readers = { pool: dependencies.pool, access: dependencies.access, tokens: tokens(dependencies) };
  if (target.kind === 'board') {
    const { value } = await readBoard(readers, target.id, context);
    return value?.availability === 'available' && value.visibility !== 'taken_down' ? 'available' : 'unavailable';
  }
  if (target.kind === 'thread') {
    const { value } = await readThread(readers, target.id, context);
    return value?.availability === 'available' &&
      value.visibility !== 'taken_down' &&
      value.firstPost.availability === 'available'
      ? 'available'
      : 'unavailable';
  }
  const located = await snapshot(dependencies, target.id, context.deadline, (client) =>
    readReportPostThread.run(client, { route: route(target.id), id: target.id }),
  );
  if (!located.value || routeOf(located.value.thread_id) !== route(target.id)) return 'unavailable';
  const { value } = await readPost(readers, located.value.thread_id, target.id, context);
  return value?.availability === 'available' && value.visibility !== 'taken_down' ? 'available' : 'unavailable';
}

/** Lists always use inspection, even when a moderator happens to own a report. */
async function inspectReport(
  dependencies: ReportDependencies,
  reportId: ReportId,
  target: ReportTarget,
  context: ReadContext,
): Promise<Anchored<ReportView | null>> {
  const initial = await inspect(dependencies, target, context);
  if (!initial.value) return { ...initial, value: null };
  const record = await loadReport(dependencies, reportId, context, true);
  const final = await inspect(dependencies, target, context);
  return {
    ...record,
    value:
      record.value && final.value && record.value.target_kind === target.kind && record.value.target_id === target.id
        ? view(record.value)
        : null,
  };
}

export async function readReport(
  dependencies: ReportDependencies,
  reportId: ReportId,
  context: ReadContext,
): Promise<Anchored<ReportView | null>> {
  // Resolve only references until ownership or current target inspection passes.
  const reference = await loadReport(dependencies, reportId, context, false);
  if (!reference.value) return { ...reference, value: null };
  const target: ReportTarget = { kind: reference.value.target_kind, id: reference.value.target_id };

  if (context.actor.kind === 'account' && reference.value.reporter_account_id === context.actor.accountId) {
    const owner = context.actor.accountId;
    if (await reporterCanReadOwnReport(dependencies, context.actor, owner, context)) {
      const record = await loadReport(dependencies, reportId, context, true, owner);
      if (!record.value || !sameReportReference(reference.value, record.value)) return { ...record, value: null };
      const availability = await targetAvailability(dependencies, target, context);
      const finalReference = await loadReport(dependencies, reportId, context, false, owner);
      if (
        !finalReference.value ||
        !sameReportReference(reference.value, finalReference.value) ||
        !(await reporterCanReadOwnReport(dependencies, context.actor, owner, context))
      )
        return { ...finalReference, value: null };
      // Retain the native adapter's existing complete signature for direct callers.
      // HTTP uses reportReadView to expose only the reporter's submitted record.
      const submitted = { ...view(record.value), targetAvailability: availability };
      return { ...finalReference, value: submitted };
    }
  }

  return inspectReport(dependencies, reportId, target, context);
}

/** Closed reporter projection, independent of the required moderator/list fields. */
export function reportReadView(report: ReportView): ReportReadView {
  if (!('targetAvailability' in report)) return report;
  if (report.targetAvailability !== 'available' && report.targetAvailability !== 'unavailable')
    throw new TypeError('Invalid reporter target availability');
  return {
    id: report.id,
    target: report.target,
    revisionId: report.revisionId,
    reason: report.reason,
    evidence: report.evidence,
    reporterId: report.reporterId,
    createdAt: report.createdAt,
    outcome: report.outcome,
    resolvedAt: report.resolvedAt,
    targetAvailability: report.targetAvailability,
  };
}

export async function listTargetReports(
  dependencies: ReportDependencies,
  target: ReportTarget,
  context: ReadContext,
  cursor?: string,
  limit = target.kind === 'subject' ? CATALOGUE_REPORT_PAGE_LIMIT : 100,
): Promise<Page<ReportView>> {
  return listSelectedTargetReports(dependencies, target, context, cursor, limit);
}

/** Additive selection adapter; the original native list contract retains its defaults. */
export async function listSelectedTargetReports(
  dependencies: ReportDependencies,
  target: ReportTarget,
  context: ReadContext,
  cursor?: string,
  limit = target.kind === 'subject' ? CATALOGUE_REPORT_PAGE_LIMIT : 100,
  selection: ReportSelection = {},
): Promise<Page<ReportView>> {
  return listReports(dependencies, target, context, cursor, limit, selection);
}

export function listCatalogueReports(
  dependencies: ReportDependencies,
  context: ReadContext,
  cursor?: string,
  limit = 20,
  selection: ReportSelection = {},
) {
  return listReports(dependencies, { kind: 'catalogue', id: GLOBAL_CONTEXT }, context, cursor, limit, selection);
}

async function listReports(
  dependencies: ReportDependencies,
  target: ReportScope,
  context: ReadContext,
  cursor: string | undefined,
  limit: number,
  selection: ReportSelection,
): Promise<Page<ReportView>> {
  if (target.kind !== 'catalogue') validateTarget(target);
  if ((target.kind === 'catalogue' || target.kind === 'subject') && limit > CATALOGUE_REPORT_PAGE_LIMIT)
    throw new RangeError('Report limit must be 1 to 50');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Report limit must be 1 to 100');
  const status = selection.status ?? 'all';
  const targetKind = selection.targetKind ?? 'all';
  const order = selection.order ?? 'newest';
  if (
    !['all', 'pending', 'resolved'].includes(status) ||
    !['all', 'board', 'thread', 'post', 'subject', 'space', 'realm'].includes(targetKind) ||
    !['newest', 'oldest'].includes(order)
  )
    throw new TypeError('Invalid report selection');
  const initial = await inspect(dependencies, target, context);
  const empty = { entries: [], nextCursor: null, anchor: initial.anchor };
  if (!initial.value) return empty;
  const ring = tokens(dependencies);
  const binding: CursorBinding = {
    // Versioned binding deliberately refuses legacy cursors lacking selection/credential authority.
    operation: target.kind === 'catalogue' ? 'catalogue_report.list' : 'content.target-reports.v2',
    parameters: {
      kind: target.kind,
      id: target.id,
      actor: context.actor.kind === 'account' ? context.actor.accountId : null,
      client: context.actor.kind === 'account' ? context.actor.clientId : null,
      requestedBy: context.actor.kind === 'account' ? context.actor.requestedBy : null,
      authnEpoch: context.actor.kind === 'account' ? context.actor.authnEpoch : null,
      scopes: context.actor.kind === 'account' ? JSON.stringify([...new Set(context.actor.scopes)].sort()) : null,
      status,
      targetKind,
      order,
      limit,
    },
  };
  let after: { at: string; id: string } | null = null;
  if (cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, cursor);
    if (
      !decoded.ok ||
      decoded.epoch !== initial.anchor.epoch ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' ||
      typeof decoded.after[1] !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(decoded.after[0]) ||
      !Number.isFinite(Date.parse(decoded.after[0])) ||
      routeOf(decoded.after[1]) === null
    )
      throw new TypeError('Invalid report cursor');
    after = { at: decoded.after[0], id: decoded.after[1] };
  }
  const candidates = await snapshot(dependencies, target.id, context.deadline, async (client) => {
    const parameters = {
      route: route(target.id),
      board_id: target.id,
      target_kind: target.kind === 'catalogue' ? targetKind : target.kind,
      target_id: target.id,
      created_at: after?.at ?? (order === 'oldest' ? '-infinity' : 'infinity'),
      oldest: order === 'oldest',
      report_id: after?.id ?? '00000000-0000-0000-0000-000000000000',
      limit: limit + 1,
    };
    const statement = target.kind === 'catalogue' ? (targetKind === 'all' ? cataloguePage : catalogueKindPage) : target.kind === 'board' ? boardPage : page;
    const { rows } = await client.query<{
      report_route: number;
      report_id: string;
      created_at: string;
      target_kind: ReportTarget['kind'];
      target_id: string;
    }>(
      statement.sql,
      statement.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    return rows;
  });
  const selected = candidates.value.slice(0, limit);
  const entries: ReportView[] = [];
  for (const candidate of selected) {
    if (route(candidate.report_id) !== candidate.report_route) throw new ReportUnavailableError();
    const candidateTarget: ReportTarget = { kind: candidate.target_kind, id: candidate.target_id };
    if (targetKind !== 'all' && candidateTarget.kind !== targetKind) continue;
    // Explicit inspection is required even when the viewer also owns the report.
    if (!(await inspect(dependencies, candidateTarget, context)).value) continue;
    if (
      target.kind === 'board' &&
      (
        await snapshot(dependencies, candidateTarget.id, context.deadline, (client) =>
          reportBoardPlacement(client, candidateTarget),
        )
      ).value !== target.id
    )
      continue;
    const record = await inspectReport(dependencies, candidate.report_id, candidateTarget, context);
    if (
      !record.value ||
      record.value.target.id !== candidateTarget.id ||
      record.value.target.kind !== candidateTarget.kind
    )
      continue;
    if (!(await inspect(dependencies, candidateTarget, context)).value) continue;
    if (
      target.kind === 'board' &&
      (
        await snapshot(dependencies, candidateTarget.id, context.deadline, (client) =>
          reportBoardPlacement(client, candidateTarget),
        )
      ).value !== target.id
    )
      continue;
    if (status === 'pending' && record.value.outcome !== null) continue;
    if (status === 'resolved' && record.value.outcome === null) continue;
    entries.push(record.value);
  }
  // No evidence or identifiers leave the adapter after revocation during hydration.
  const final = await inspect(dependencies, target, context);
  if (!final.value) return { ...empty, anchor: final.anchor };
  const last = selected.at(-1);
  return {
    entries,
    anchor: final.anchor,
    nextCursor:
      candidates.value.length > limit && last
        ? encodeCursor(ring, binding, { epoch: final.anchor.epoch, after: [last.created_at, last.report_id] })
        : null,
  };
}
