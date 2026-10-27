import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { requestDigest } from '../http/request.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { Access, AccessContext, Actor, Resource } from '../request/access.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import globalRead from './bootstrap-governance-read.sql';
import accountRead from './agent-verification-account-read.sql';
import insertRequest from './agent-verification-request-insert.sql';
import requestRead from './agent-verification-request-read.sql';
import latestRequest from './agent-verification-request-latest.sql';
import pendingAccountRead from './agent-verification-pending-account-read.sql';
import pendingPage from './agent-verification-pending-page.sql';
import withdrawRequest from './agent-verification-withdraw.sql';
import decideRequest from './agent-verification-decision.sql';
import accountPending from './agent-verification-account-pending.sql';
import accountComplete from './agent-verification-account-complete.sql';
import accountClear from './agent-verification-account-clear.sql';
import accountReverse from './agent-verification-account-reverse.sql';
import agentPageDelete from './agent-verification-page-delete.sql';
import agentPageInsert from './agent-verification-page-insert.sql';
import requestApproved from './agent-verification-request-approved.sql';
import requestFailed from './agent-verification-request-failed.sql';

export type AccountVerificationLink = { label: string; url: string };
export type AgentVerificationRequestInput = {
  accountId: string;
  subject: string;
  statement: string;
  links: readonly AccountVerificationLink[];
  key: string;
};
export type AgentVerificationState = 'pending' | 'approving' | 'approved' | 'rejected' | 'withdrawn' | 'failed';
export type AgentVerificationRequest = {
  id: string;
  accountId: string;
  accountKind: 'actor' | 'organization';
  requestedBy: string;
  catalogueSubjectId: string;
  statement: string;
  links: AccountVerificationLink[];
  state: AgentVerificationState;
  reason: string | null;
  problem: { type: string; detail: string } | null;
  decisionReceiptId: string | null;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
};
export type PendingVerificationPage = { verificationRequests: AgentVerificationRequest[]; next: string | null };

type VerificationAccount = {
  route: number;
  accountId: string;
  kind: 'actor' | 'organization';
  state: 'pending' | 'active' | 'suspended' | 'deleted';
  fenced: boolean;
  operatorAccountId: string | null;
  minimumAuthnEpoch: string;
  agentVerified: boolean;
  agentSubjectId: string | null;
  agentVerificationReceiptId: string | null;
  pendingAgentSubjectId: string | null;
  pendingAgentReceiptId: string | null;
};

type VerificationRow = {
  id: string;
  accountId: string;
  accountKind: 'actor' | 'organization';
  requestedBy: string;
  catalogueSubjectId: string;
  statement: string;
  links: unknown;
  state: AgentVerificationState;
  reason: string | null;
  problemType: string | null;
  problemDetail: string | null;
  decisionReceiptId: string | null;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type VerificationContext = AccessContext & { actor: Actor };
const FIRST_CREATED_AT = '0001-01-01 00:00:00+00';
const FIRST_REQUEST_ID = '00000000-0000-0000-0000-000000000000';

export class AgentVerificationDeniedError extends Error {
  constructor() {
    super('Account agent verification is not authorized');
    this.name = 'AgentVerificationDeniedError';
  }
}

export class AgentVerificationConflictError extends Error {
  constructor() {
    super('The verification request is no longer pending');
    this.name = 'AgentVerificationConflictError';
  }
}

export class AgentVerificationAccountError extends Error {
  readonly problemType = 'account_verification_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'AgentVerificationAccountError';
  }
}

export class AgentVerificationPageConflictError extends Error {
  readonly problemType = 'agent_verification_page_conflict';

  constructor() {
    super('The catalogue subject already points to another verification');
    this.name = 'AgentVerificationPageConflictError';
  }
}

function rows<T>(result: T[] | T | null | undefined): T[] {
  return result == null ? [] : Array.isArray(result) ? result : [result];
}

function asRequest(row: VerificationRow): AgentVerificationRequest {
  return {
    id: row.id,
    accountId: row.accountId,
    accountKind: row.accountKind,
    requestedBy: row.requestedBy,
    catalogueSubjectId: row.catalogueSubjectId,
    statement: row.statement,
    links: row.links as AccountVerificationLink[],
    state: row.state,
    reason: row.reason,
    problem: row.problemType && row.problemDetail ? { type: row.problemType, detail: row.problemDetail } : null,
    decisionReceiptId: row.decisionReceiptId,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validLinks(value: unknown): value is readonly AccountVerificationLink[] {
  if (!Array.isArray(value) || value.length > 5) return false;
  return value.every((entry) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => key !== 'label' && key !== 'url')
    )
      return false;
    const { label, url } = entry as Record<string, unknown>;
    if (
      typeof label !== 'string' ||
      Array.from(label).length < 1 ||
      Array.from(label).length > 64 ||
      typeof url !== 'string' ||
      Array.from(url).length > 2048
    )
      return false;
    if (!/^https:\/\/[^/@\s]+(?:[/?#]|$)/i.test(url) || /[\u0000-\u0020\u007f]/.test(url)) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  });
}

function validRequestInput(input: AgentVerificationRequestInput): boolean {
  return (
    routeOf(input.accountId) !== null &&
    routeOf(input.subject) !== null &&
    input.subject !== input.accountId &&
    typeof input.statement === 'string' &&
    Array.from(input.statement).length >= 1 &&
    Array.from(input.statement).length <= 2000 &&
    validLinks(input.links) &&
    typeof input.key === 'string' &&
    input.key.length >= 1 &&
    input.key.length <= 255
  );
}

function currentActorAccount(account: VerificationAccount | null, actor: Extract<Actor, { kind: 'account' }>): boolean {
  return (
    account !== null &&
    account.accountId === actor.accountId &&
    account.kind === 'actor' &&
    account.state === 'active' &&
    !account.fenced &&
    BigInt(account.minimumAuthnEpoch) <= BigInt(actor.authnEpoch)
  );
}

function humanAccount(account: VerificationAccount | null, actor: Extract<Actor, { kind: 'account' }>): boolean {
  return currentActorAccount(account, actor) && account?.operatorAccountId === null;
}

function freshAccountAuthorization(
  access: Access,
  actor: Actor,
  accountId: string,
  action: string,
  context: VerificationContext,
  reversing = false,
) {
  const route = routeOf(accountId);
  if (actor.kind !== 'account' || route === null || context.pool === undefined)
    throw new AgentVerificationDeniedError();
  const resource: Resource = { route, id: accountId };
  return resourceAuthorization({
    access,
    actor,
    action,
    anchor: {
      resource,
      async validate(client) {
        const target = await accountRead.run(client as PoolClient, { route, account_id: accountId });
        const actingRoute = routeOf(actor.accountId);
        if (actingRoute === null) return false;
        const acting =
          actor.accountId === accountId
            ? (target as VerificationAccount | null)
            : ((await accountRead.run(client as PoolClient, {
                route: actingRoute,
                account_id: actor.accountId,
              })) as VerificationAccount | null);
        if (!(reversing ? currentActorAccount(acting, actor) : humanAccount(acting, actor))) return false;
        return (
          target?.state === 'active' &&
          !target.fenced &&
          ((actor.accountId === accountId && target.kind === 'actor') ||
            (actor.accountId !== accountId && target.kind === 'organization')) &&
          (reversing ||
            (!target.agentVerified &&
              target.agentSubjectId === null &&
              target.pendingAgentSubjectId === null &&
              target.pendingAgentReceiptId === null))
        );
      },
    },
    context: { pool: context.pool, deadline: context.deadline, partition: reversing ? partitionOf(route) : 0 },
  });
}

function globalCommandAuthorization(access: Access, actor: Actor, context: VerificationContext, partition = 0) {
  if (actor.kind !== 'account' || context.pool === undefined) throw new AgentVerificationDeniedError();
  return resourceAuthorization({
    access,
    actor,
    action: 'account:verify_agent',
    anchor: {
      resource: PLATFORM_RESOURCE,
      async validate(client) {
        const row = await globalRead.run(client as PoolClient, {
          route: PLATFORM_RESOURCE.route,
          resource_id: PLATFORM_RESOURCE.id,
        });
        return row?.global === true;
      },
    },
    context: { pool: context.pool, deadline: context.deadline, partition },
  });
}

async function authorizeRead(
  pool: Pool,
  access: Access,
  actor: Actor,
  action: string,
  resource: Resource,
  context: VerificationContext,
  validate: (client: PoolClient) => Promise<boolean>,
  read: (client: PoolClient) => Promise<unknown>,
): Promise<{ allowed: boolean; value?: unknown }> {
  if (actor.kind !== 'account' || !access.prepare || context.pool !== pool) return { allowed: false };
  const evidence = await access.prepare(actor, action, resource, context);
  if (evidence === null || evidence === undefined) return { allowed: false };
  return withReadTransaction(pool, async (client) => {
    if (!(await validate(client))) return { allowed: false };
    if (!(await access.authorize(client, actor, action, resource, evidence))) return { allowed: false };
    return { allowed: true, value: await read(client) };
  });
}

/** One status lookup for the actor's own latest request or a managed organization. */
export async function readLatestAgentVerificationRequest(
  pool: Pool,
  access: Access,
  context: VerificationContext,
  accountId: string,
): Promise<AgentVerificationRequest | null> {
  const route = routeOf(accountId);
  const { actor } = context;
  if (route === null || actor.kind !== 'account') throw new AgentVerificationDeniedError();
  const action = actor.accountId === accountId ? 'account:read' : 'account:manage';
  const result = await authorizeRead(
    pool,
    access,
    actor,
    action,
    { route, id: accountId },
    context,
    async (client) => {
      const target = (await accountRead.run(client, { route, account_id: accountId })) as VerificationAccount | null;
      const actorRoute = routeOf(actor.accountId);
      const acting =
        actorRoute === null
          ? null
          : actor.accountId === accountId
            ? target
            : ((await accountRead.run(client, {
                route: actorRoute,
                account_id: actor.accountId,
              })) as VerificationAccount | null);
      return (
        humanAccount(acting, actor) &&
        target?.state === 'active' &&
        ((actor.accountId === accountId && target.kind === 'actor') ||
          (actor.accountId !== accountId && target.kind === 'organization'))
      );
    },
    (client) => latestRequest.run(client, { account_id: accountId }),
  );
  if (!result.allowed) throw new AgentVerificationDeniedError();
  const row = rows<VerificationRow>(result.value as VerificationRow[] | VerificationRow | null)[0];
  return row ? asRequest(row) : null;
}

/** Pending governance page; the partial index excludes every decided request. */
export async function readPendingAgentVerificationRequests(
  pool: Pool,
  access: Access,
  context: VerificationContext,
  tokens: KeyRing,
  input: { limit?: number; cursor?: string },
  at: Date,
): Promise<PendingVerificationPage> {
  const { actor } = context;
  if (actor.kind !== 'account') throw new AgentVerificationDeniedError();
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  if (!Number.isFinite(at.getTime())) throw new ProblemError('invalid_request');
  const binding = {
    route: 'GET /v1/verification-requests',
    viewer: actor.accountId,
    query: { state: 'pending', sort: 'created_at:asc,request_id:asc', limit },
  };
  let afterCreated = FIRST_CREATED_AT;
  let afterRequest = FIRST_REQUEST_ID;
  if (input.cursor !== undefined) {
    const decoded = await decodeListCursor(tokens, binding, input.cursor, at);
    if (
      !decoded.ok ||
      decoded.epoch !== 1 ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' ||
      typeof decoded.after[1] !== 'string' ||
      routeOf(decoded.after[1]) !== 0
    )
      throw new ProblemError('invalid_cursor');
    afterCreated = decoded.after[0];
    afterRequest = decoded.after[1];
  }
  const result = await authorizeRead(
    pool,
    access,
    actor,
    'account:verify_agent',
    PLATFORM_RESOURCE,
    context,
    async (client) => {
      const row = await globalRead.run(client, { route: PLATFORM_RESOURCE.route, resource_id: PLATFORM_RESOURCE.id });
      return row?.global === true;
    },
    (client) =>
      pendingPage.run(client, {
        after_created: afterCreated,
        after_request_id: afterRequest,
        limit: limit + 1,
      }),
  );
  if (!result.allowed) throw new AgentVerificationDeniedError();

  const page = rows<VerificationRow>(result.value as VerificationRow[] | VerificationRow | null);
  const selected = page.slice(0, limit);
  return {
    verificationRequests: selected.map(asRequest),
    next:
      page.length > limit && selected.length
        ? await encodeListCursor(
            tokens,
            binding,
            { epoch: 1, after: [selected.at(-1)!.createdAt, selected.at(-1)!.id] },
            at,
          )
        : null,
  };
}

export function createAgentVerificationCommands(config: { pool: Pool; access: Access; clock: () => Date }) {
  return {
    async revoke(context: VerificationContext, input: { accountId: string; key: string; reason?: string }) {
      return reverse(config, context, input, 'revoked');
    },
    async release(context: VerificationContext, input: { accountId: string; key: string }) {
      return reverse(config, context, input, 'released');
    },
    async request(
      context: VerificationContext,
      input: AgentVerificationRequestInput,
    ): Promise<CommandOutcome<AgentVerificationRequest>> {
      input = structuredClone(input);
      const { actor } = context;
      if (
        actor.kind !== 'account' ||
        context.pool !== config.pool ||
        !validRequestInput(input) ||
        routeOf(input.subject) === null
      )
        throw new ProblemError('invalid_request');
      const authorization = freshAccountAuthorization(
        config.access,
        actor,
        input.accountId,
        actor.accountId === input.accountId ? 'account:update' : 'account:manage',
        context,
      );
      const requestId = newId(0);
      const digest = requestDigest('account.request_agent_verification', actor, {
        accountId: input.accountId,
        subject: input.subject,
        statement: input.statement,
        links: input.links,
      });
      try {
        return await runCommand(
          config.pool,
          {
            partition: 0,
            basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
            deadline: context.deadline,
            clock: config.clock,
            authorization,
            receipt: {
              actorAccountId: actor.accountId,
              kind: 'access.agent-verification.request',
              key: input.key,
              digest,
            },
          },
          async (tx, { transactionId }) => {
            const existing = rows<VerificationRow>(
              await pendingAccountRead.run(tx as PoolClient, { account_id: input.accountId }),
            )[0];
            if (existing) throw new AgentVerificationConflictError();
            const [saved] = rows<VerificationRow>(
              await insertRequest.run(tx as PoolClient, {
                request_id: requestId,
                account_id: input.accountId,
                account_kind: actor.accountId === input.accountId ? 'actor' : 'organization',
                requested_by: actor.accountId,
                catalogue_subject_id: input.subject,
                statement: input.statement,
                links: input.links,
                transaction_id: transactionId,
              }),
            );
            if (!saved) throw new Error('Agent verification request insert returned no row');
            const value = asRequest(saved);
            return {
              value,
              events: [
                {
                  type: 'com.rezics.access.agent-verification.requested.v1',
                  subject: value.accountId,
                  data: {
                    requestId: value.id,
                    accountId: value.accountId,
                    catalogueSubjectId: value.catalogueSubjectId,
                  },
                },
              ],
            };
          },
        );
      } catch (error) {
        if (error instanceof AgentVerificationConflictError) throw error;
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        const constraint =
          typeof error === 'object' && error !== null && 'constraint' in error ? String(error.constraint) : '';
        if (code === '23505' && constraint === 'agent_verification_active_account_idx')
          throw new AgentVerificationConflictError();
        throw error;
      }
    },

    async withdraw(
      context: VerificationContext,
      input: { accountId: string; key: string },
    ): Promise<CommandOutcome<AgentVerificationRequest>> {
      input = { ...input };
      const { actor } = context;
      if (
        actor.kind !== 'account' ||
        context.pool !== config.pool ||
        routeOf(input.accountId) === null ||
        typeof input.key !== 'string' ||
        input.key.length < 1 ||
        input.key.length > 255
      )
        throw new ProblemError('invalid_request');
      const action = actor.accountId === input.accountId ? 'account:update' : 'account:manage';
      const authorization = freshAccountAuthorization(config.access, actor, input.accountId, action, context);
      return runCommand(
        config.pool,
        {
          partition: 0,
          basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
          deadline: context.deadline,
          clock: config.clock,
          authorization,
          receipt: {
            actorAccountId: actor.accountId,
            kind: 'access.agent-verification.withdraw',
            key: input.key,
            digest: requestDigest('account.withdraw_agent_verification', actor, { accountId: input.accountId }),
          },
        },
        async (tx, { transactionId }) => {
          const [saved] = rows<VerificationRow>(
            await withdrawRequest.run(tx as PoolClient, {
              account_id: input.accountId,
              transaction_id: transactionId,
            }),
          );
          if (!saved) throw new AgentVerificationConflictError();
          const value = asRequest(saved);
          return {
            value,
            events: [
              {
                type: 'com.rezics.access.agent-verification.withdrawn.v1',
                subject: value.accountId,
                data: { requestId: value.id, accountId: value.accountId },
              },
            ],
          };
        },
      );
    },

    async approve(
      context: VerificationContext,
      input: { requestId: string; key: string; reason?: string },
    ): Promise<CommandOutcome<AgentVerificationRequest>> {
      return decide(config, context, input, 'approving', input.reason ?? null);
    },

    async reject(
      context: VerificationContext,
      input: { requestId: string; key: string; reason?: string },
    ): Promise<CommandOutcome<AgentVerificationRequest>> {
      return decide(config, context, input, 'rejected', input.reason ?? null);
    },
  };
}

async function decide(
  config: { pool: Pool; access: Access; clock: () => Date },
  context: VerificationContext,
  input: { requestId: string; key: string; reason?: string },
  state: 'approving' | 'rejected',
  reason: string | null,
): Promise<CommandOutcome<AgentVerificationRequest>> {
  input = { ...input };
  const { actor } = context;
  if (
    actor.kind !== 'account' ||
    context.pool !== config.pool ||
    routeOf(input.requestId) !== 0 ||
    typeof input.key !== 'string' ||
    input.key.length < 1 ||
    input.key.length > 255 ||
    (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500))
  )
    throw new ProblemError('invalid_request');
  const authorization = globalCommandAuthorization(config.access, actor, context);
  const isApproval = state === 'approving';
  const digest = requestDigest(
    isApproval ? 'account.approve_agent_verification' : 'account.reject_agent_verification',
    actor,
    { requestId: input.requestId, reason },
  );
  return runCommand(
    config.pool,
    {
      partition: 0,
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      deadline: context.deadline,
      clock: config.clock,
      authorization,
      receipt: {
        actorAccountId: actor.accountId,
        kind: isApproval ? 'access.agent-verification.approve' : 'access.agent-verification.reject',
        key: input.key,
        digest,
      },
    },
    async (tx, { transactionId }) => {
      const [saved] = rows<VerificationRow>(
        await decideRequest.run(tx as PoolClient, {
          request_id: input.requestId,
          state,
          reason,
          receipt_id: transactionId,
          decided_by: actor.accountId,
          transaction_id: transactionId,
        }),
      );
      if (!saved) throw new AgentVerificationConflictError();
      const value = asRequest(saved);
      return {
        value,
        events: [
          {
            type: isApproval
              ? 'com.rezics.access.agent-verification.approved.v1'
              : 'com.rezics.access.agent-verification.rejected.v1',
            subject: value.accountId,
            data: {
              requestId: value.id,
              accountId: value.accountId,
              catalogueSubjectId: value.catalogueSubjectId,
              receiptId: value.decisionReceiptId!,
            },
          },
        ],
      };
    },
  );
}

export type AgentVerificationWorkflowRequest = Pick<
  AgentVerificationRequest,
  'id' | 'accountId' | 'accountKind' | 'requestedBy' | 'catalogueSubjectId' | 'state' | 'decisionReceiptId'
>;

/** Durable workflow read: one primary-key lookup in the Global Context partition. */
export async function readAgentVerificationWorkflowRequest(
  pool: Pool,
  requestId: string,
): Promise<AgentVerificationWorkflowRequest | null> {
  const row = rows<VerificationRow>(await requestRead.run(pool, { request_id: requestId }))[0];
  return row
    ? {
        id: row.id,
        accountId: row.accountId,
        accountKind: row.accountKind,
        requestedBy: row.requestedBy,
        catalogueSubjectId: row.catalogueSubjectId,
        state: row.state,
        decisionReceiptId: row.decisionReceiptId,
      }
    : null;
}

/** Step one records the approval on the account anchor before semantic platform work. */
export async function recordPendingAgentVerification(
  pool: Pool,
  input: AgentVerificationWorkflowRequest & { receiptId: string },
  clock: () => Date,
): Promise<void> {
  const route = routeOf(input.accountId);
  if (route === null) throw new AgentVerificationAccountError('The account route is invalid');
  const accountKind = input.accountKind === 'actor' ? 'actor' : 'organization';
  const digest = createHash('sha256')
    .update(JSON.stringify([input.id, input.accountId, accountKind, input.catalogueSubjectId, input.receiptId]))
    .digest();
  await runCommand(
    pool,
    {
      partition: partitionOf(route),
      receipt: {
        actorAccountId: input.requestedBy,
        kind: 'access.agent-verification.pending',
        key: `${input.id}:pending`,
        digest,
      },
      clock,
    },
    async (tx, { transactionId }) => {
      const account = (await accountRead.run(tx as PoolClient, {
        route,
        account_id: input.accountId,
      })) as VerificationAccount | null;
      if (
        !account ||
        account.state !== 'active' ||
        account.fenced ||
        account.kind !== accountKind ||
        account.agentVerified ||
        account.agentSubjectId !== null ||
        account.pendingAgentSubjectId !== null ||
        account.pendingAgentReceiptId !== null
      )
        throw new AgentVerificationAccountError('The account is not active and eligible for verification');
      const [recorded] = rows(
        await accountPending.run(tx as PoolClient, {
          route,
          account_id: input.accountId,
          account_kind: accountKind,
          catalogue_subject_id: input.catalogueSubjectId,
          receipt_id: input.receiptId,
          transaction_id: transactionId,
        }),
      );
      if (!recorded) throw new AgentVerificationAccountError('The account could not record pending verification');
      return {
        value: { requestId: input.id, accountId: input.accountId },
        events: [
          {
            type: 'com.rezics.access.account-updated.v1',
            subject: input.accountId,
            data: { accountId: input.accountId },
          },
        ],
      };
    },
  );
}

/** Idempotent semantic step. The semantic service uses the committed decision receipt as its merge receipt. */
export async function mergeVerifiedAgent(
  pool: Pool,
  input: AgentVerificationWorkflowRequest & { receiptId: string },
): Promise<void> {
  const { verifyAccountAgent } = await import('../semantic/account-agents.ts');
  await verifyAccountAgent(pool, {
    account: input.accountId,
    catalogue: input.catalogueSubjectId,
    receipt: input.receiptId,
  });
}

/** Persist the public-page pointer on the subject's route after Semantic has accepted the merge. */
export async function writeAgentVerificationPage(
  pool: Pool,
  input: AgentVerificationWorkflowRequest & { receiptId: string },
): Promise<void> {
  const route = routeOf(input.catalogueSubjectId);
  if (route === null) throw new AgentVerificationAccountError('The catalogue subject route is invalid');
  await withConnection(pool, async (client) => {
    const [page] = rows(
      await agentPageInsert.run(client, {
        route,
        subject_id: input.catalogueSubjectId,
        account_id: input.accountId,
        verification_receipt_id: input.receiptId,
      }),
    );
    if (!page) throw new AgentVerificationPageConflictError();
  });
}

/** Completion is a second, idempotent point command after the semantic merge commits. */
export async function completeAgentVerification(
  pool: Pool,
  input: AgentVerificationWorkflowRequest & { receiptId: string },
  clock: () => Date,
): Promise<void> {
  const route = routeOf(input.accountId);
  if (route === null) throw new AgentVerificationAccountError('The account route is invalid');
  const digest = createHash('sha256')
    .update(JSON.stringify([input.id, input.accountId, input.catalogueSubjectId, input.receiptId, 'complete']))
    .digest();
  await runCommand(
    pool,
    {
      partition: partitionOf(route),
      receipt: {
        actorAccountId: input.requestedBy,
        kind: 'access.agent-verification.complete',
        key: `${input.id}:complete`,
        digest,
      },
      clock,
    },
    async (tx, { transactionId }) => {
      const [completed] = rows(
        await accountComplete.run(tx as PoolClient, {
          route,
          account_id: input.accountId,
          catalogue_subject_id: input.catalogueSubjectId,
          receipt_id: input.receiptId,
          transaction_id: transactionId,
        }),
      );
      if (!completed)
        throw new AgentVerificationAccountError('The account verification marker changed during approval');
      return {
        value: { accountId: input.accountId },
        events: [
          {
            type: 'com.rezics.access.account-updated.v1',
            subject: input.accountId,
            data: { accountId: input.accountId },
          },
        ],
      };
    },
  );
}

/** Failure cleanup and terminal request update use independent receipts so restart resumes either half. */
export async function clearPendingAgentVerification(
  pool: Pool,
  input: AgentVerificationWorkflowRequest & { receiptId: string },
  clock: () => Date,
): Promise<void> {
  const route = routeOf(input.accountId);
  if (route === null) return;
  const digest = createHash('sha256')
    .update(JSON.stringify([input.id, input.accountId, input.catalogueSubjectId, input.receiptId, 'clear']))
    .digest();
  await runCommand(
    pool,
    {
      partition: partitionOf(route),
      receipt: {
        actorAccountId: input.requestedBy,
        kind: 'access.agent-verification.clear',
        key: `${input.id}:clear`,
        digest,
      },
      clock,
    },
    async (tx, { transactionId }) => {
      await accountClear.run(tx as PoolClient, {
        route,
        account_id: input.accountId,
        catalogue_subject_id: input.catalogueSubjectId,
        receipt_id: input.receiptId,
        transaction_id: transactionId,
      });
      return {
        value: { accountId: input.accountId },
        events: [
          {
            type: 'com.rezics.access.account-updated.v1',
            subject: input.accountId,
            data: { accountId: input.accountId },
          },
        ],
      };
    },
  );
}

export async function finishAgentVerification(
  pool: Pool,
  input: AgentVerificationWorkflowRequest & { receiptId: string },
  clock: () => Date,
): Promise<void> {
  const digest = createHash('sha256')
    .update(JSON.stringify([input.id, input.accountId, input.catalogueSubjectId, input.receiptId, 'approved']))
    .digest();
  await runCommand(
    pool,
    {
      partition: 0,
      receipt: {
        actorAccountId: input.requestedBy,
        kind: 'access.agent-verification.finish',
        key: `${input.id}:finish`,
        digest,
      },
      clock,
    },
    async (tx, { transactionId }) => {
      const [finished] = rows(
        await requestApproved.run(tx as PoolClient, {
          request_id: input.id,
          receipt_id: input.receiptId,
          transaction_id: transactionId,
        }),
      );
      if (!finished) throw new AgentVerificationConflictError();
      return {
        value: { requestId: input.id, accountId: input.accountId },
        events: [
          {
            type: 'com.rezics.access.agent-verification.verified.v1',
            subject: input.accountId,
            data: {
              requestId: input.id,
              accountId: input.accountId,
              catalogueSubjectId: input.catalogueSubjectId,
              receiptId: input.receiptId,
            },
          },
        ],
      };
    },
  );
}

export async function failAgentVerification(
  pool: Pool,
  input: AgentVerificationWorkflowRequest & { receiptId: string; problem: { type: string; detail: string } },
  clock: () => Date,
): Promise<void> {
  const digest = createHash('sha256')
    .update(JSON.stringify([input.id, input.accountId, input.catalogueSubjectId, input.receiptId, input.problem]))
    .digest();
  await runCommand(
    pool,
    {
      partition: 0,
      receipt: {
        actorAccountId: input.requestedBy,
        kind: 'access.agent-verification.fail',
        key: `${input.id}:fail`,
        digest,
      },
      clock,
    },
    async (tx, { transactionId }) => {
      const [failed] = rows(
        await requestFailed.run(tx as PoolClient, {
          request_id: input.id,
          receipt_id: input.receiptId,
          problem_type: input.problem.type.slice(0, 128),
          problem_detail: input.problem.detail.slice(0, 512),
          transaction_id: transactionId,
        }),
      );
      if (!failed) throw new AgentVerificationConflictError();
      return {
        value: { requestId: input.id, accountId: input.accountId, problem: input.problem },
        events: [
          {
            type: 'com.rezics.access.agent-verification.failed.v1',
            subject: input.accountId,
            data: {
              requestId: input.id,
              accountId: input.accountId,
              catalogueSubjectId: input.catalogueSubjectId,
              receiptId: input.receiptId,
              problemType: input.problem.type.slice(0, 128),
            },
          },
        ],
      };
    },
  );
}

export async function loadVerificationRequestRow(pool: Pool, requestId: string): Promise<VerificationRow | null> {
  return rows<VerificationRow>(await requestRead.run(pool, { request_id: requestId }))[0] ?? null;
}

export type AgentVerificationReversal = {
  accountId: string;
  catalogueSubjectId: string;
  verificationReceiptId: string;
  receiptId: string;
  requestedBy: string;
  kind: 'released' | 'revoked';
  reason: string | null;
};

async function reverse(
  config: { pool: Pool; access: Access; clock: () => Date },
  context: VerificationContext,
  input: { accountId: string; key: string; reason?: string },
  kind: AgentVerificationReversal['kind'],
): Promise<CommandOutcome<AgentVerificationReversal>> {
  input = { ...input };
  const { actor } = context;
  const route = routeOf(input.accountId);
  if (
    actor.kind !== 'account' ||
    context.pool !== config.pool ||
    route === null ||
    typeof input.key !== 'string' ||
    input.key.length < 1 ||
    input.key.length > 255 ||
    (input.reason !== undefined && (typeof input.reason !== 'string' || Array.from(input.reason).length > 500))
  )
    throw new ProblemError('invalid_request');
  const authorization =
    kind === 'revoked'
      ? globalCommandAuthorization(config.access, actor, context, partitionOf(route))
      : freshAccountAuthorization(
          config.access,
          actor,
          input.accountId,
          actor.accountId === input.accountId ? 'account:update' : 'account:manage',
          context,
          true,
        );
  return runCommand(
    config.pool,
    {
      partition: partitionOf(route),
      clock: config.clock,
      deadline: context.deadline,
      authorization,
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      receipt: {
        actorAccountId: actor.accountId,
        kind: `access.agent-verification.${kind}`,
        key: input.key,
        digest: requestDigest('account.reverse_agent_verification', actor, {
          accountId: input.accountId,
          kind,
          reason: input.reason ?? null,
        }),
      },
    },
    (tx, { transactionId }) =>
      commitReversal(tx as PoolClient, input.accountId, transactionId, actor.accountId, kind, input.reason ?? null),
  );
}

/** The committed decision is also step one: hide both lookups before any graph cleanup. */
async function commitReversal(
  tx: PoolClient,
  accountId: string,
  receiptId: string,
  requestedBy: string,
  kind: AgentVerificationReversal['kind'],
  reason: string | null,
) {
  const [previous] = rows(
    await accountReverse.run(tx, {
      route: routeOf(accountId)!,
      account_id: accountId,
      receipt_id: receiptId,
      transaction_id: receiptId,
    }),
  );
  if (!previous?.catalogueSubjectId || !previous.verificationReceiptId) throw new AgentVerificationConflictError();
  const value: AgentVerificationReversal = {
    accountId,
    receiptId,
    requestedBy,
    kind,
    reason,
    catalogueSubjectId: previous.catalogueSubjectId,
    verificationReceiptId: previous.verificationReceiptId,
  };
  return {
    value,
    events: [
      { type: 'com.rezics.access.agent-verification.reversing.v1', subject: accountId, data: value },
      { type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } },
    ],
  };
}

/** A tombstone is committed authority for mechanical reversal; it grants no new user permission. */
export async function reverseDeletedAccountAgent(pool: Pool, accountId: string): Promise<void> {
  const route = routeOf(accountId)!;
  const account = await accountRead.run(pool, { route, account_id: accountId });
  if (account?.state !== 'deleted') return;
  if (account.pendingAgentReceiptId !== null) throw new Error('Account agent work is still pending');
  if (!account.agentVerified) return;
  await runCommand(
    pool,
    {
      partition: partitionOf(route),
      receipt: {
        actorAccountId: accountId,
        kind: 'access.agent-verification.deleted',
        key: `delete:${account.agentVerificationReceiptId}`,
        digest: createHash('sha256').update(accountId).digest(),
      },
    },
    (tx, { transactionId }) =>
      commitReversal(tx as PoolClient, accountId, transactionId, accountId, 'revoked', 'Account deleted'),
  );
}

/** Platform work only: Semantic checks its own durable reversal receipt. */
export async function unmergeVerifiedAgent(pool: Pool, input: AgentVerificationReversal): Promise<void> {
  const account = await accountRead.run(pool, { route: routeOf(input.accountId)!, account_id: input.accountId });
  // Old outbox delivery after workflow retention must not undo a newer reviewed verification.
  if (account?.pendingAgentReceiptId !== input.receiptId || account.pendingAgentSubjectId !== input.catalogueSubjectId)
    return;
  const { unverifyAccountAgent } = await import('../semantic/account-agents.ts');
  await unverifyAccountAgent(pool, { account: input.accountId, receipt: input.receiptId });
}

export async function removeAgentVerificationPage(pool: Pool, input: AgentVerificationReversal): Promise<void> {
  await agentPageDelete.run(pool, {
    route: routeOf(input.catalogueSubjectId)!,
    subject_id: input.catalogueSubjectId,
    account_id: input.accountId,
    verification_receipt_id: input.verificationReceiptId,
  });
}

/** A distinct receipt makes final cleanup and the terminal event atomic and replay-safe. */
export async function finishAgentVerificationReversal(
  pool: Pool,
  input: AgentVerificationReversal,
  clock: () => Date,
): Promise<void> {
  await runCommand(
    pool,
    {
      partition: partitionOf(routeOf(input.accountId)!),
      clock,
      receipt: {
        actorAccountId: input.requestedBy,
        kind: 'access.agent-verification.reversed',
        key: input.receiptId,
        digest: createHash('sha256').update(JSON.stringify(input)).digest(),
      },
    },
    async (tx, { transactionId }) => {
      const [cleared] = rows(
        await accountClear.run(tx as PoolClient, {
          route: routeOf(input.accountId)!,
          account_id: input.accountId,
          catalogue_subject_id: input.catalogueSubjectId,
          receipt_id: input.receiptId,
          transaction_id: transactionId,
        }),
      );
      if (!cleared) throw new AgentVerificationConflictError();
      return {
        value: { accountId: input.accountId },
        events: [{ type: 'com.rezics.access.agent-verification.reversed.v1', subject: input.accountId, data: input }],
      };
    },
  );
}
