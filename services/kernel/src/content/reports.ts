import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { createResourceAnonymousEligibility } from '../access/eligibility.ts';
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
import { anonymousCommandTarget, anonymousRequestDigest, requestDigest } from '../http/request.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient, type Actor } from '../request/access.ts';
import { anchorRoute, derivedId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import insert from './insert-report.sql';
import page from './page-target-reports.sql';
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
  | Readonly<{ kind: 'post'; id: PostId }>;
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
  if (!target || !['board', 'thread', 'post'].includes(target.kind)) throw new TypeError('Invalid report target');
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
  if (target.kind === 'board' || !facts.threadId || route(revisionId) !== route(target.id)) return false;
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
  const resource = { route: route(target.id), id: target.id };
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
      async validate(client) {
        const partition = await readPartition(client, partitionOf(resource.route));
        if (!partition || partition.writeState === 'moved' || !observed) return false;
        const current = await targetFacts(client, target);
        if (!current || current.fingerprint !== observed.fingerprint) return false;
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
      return accessAuthorization.prepare!(attempt);
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

async function inspect(dependencies: ReportDependencies, target: ReportTarget, context: ReadContext) {
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

export async function readReport(
  dependencies: ReportDependencies,
  reportId: ReportId,
  context: ReadContext,
): Promise<Anchored<ReportView | null>> {
  const load = (includePrivate: boolean) =>
    snapshot(dependencies, reportId, context.deadline, async (client) => {
      const parameters = { route: route(reportId), report_id: reportId, include_private: includePrivate };
      const { rows } = await client.query<ReportRow>(
        read.sql,
        read.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      return rows[0] ?? null;
    });
  // Resolve only references until the current target's moderator check passes.
  const reference = await load(false);
  if (!reference.value) return { ...reference, value: null };
  const target: ReportTarget = { kind: reference.value.target_kind, id: reference.value.target_id };
  if (!(await inspect(dependencies, target, context)).value) return { ...reference, value: null };
  const record = await load(true);
  const final = await inspect(dependencies, target, context);
  return { ...record, value: record.value && final.value ? view(record.value) : null };
}

export async function listTargetReports(
  dependencies: ReportDependencies,
  target: ReportTarget,
  context: ReadContext,
  cursor?: string,
  limit = 100,
): Promise<Page<ReportView>> {
  validateTarget(target);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Report limit must be 1 to 100');
  const initial = await inspect(dependencies, target, context);
  const empty = { entries: [], nextCursor: null, anchor: initial.anchor };
  if (!initial.value) return empty;
  const ring = tokens(dependencies);
  const binding: CursorBinding = {
    operation: 'content.target-reports',
    parameters: {
      kind: target.kind,
      id: target.id,
      actor: context.actor.kind === 'account' ? context.actor.accountId : null,
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
      target_kind: target.kind,
      target_id: target.id,
      created_at: after?.at ?? 'infinity',
      report_id: after?.id ?? '00000000-0000-0000-0000-000000000000',
      limit: limit + 1,
    };
    const { rows } = await client.query<{ report_route: number; report_id: string; created_at: string }>(
      page.sql,
      page.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    return rows;
  });
  const selected = candidates.value.slice(0, limit);
  const entries: ReportView[] = [];
  for (const candidate of selected) {
    if (route(candidate.report_id) !== candidate.report_route) throw new ReportUnavailableError();
    const record = await readReport(dependencies, candidate.report_id, context);
    if (record.value?.target.id === target.id && record.value.target.kind === target.kind) entries.push(record.value);
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
