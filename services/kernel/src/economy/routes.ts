import { t } from 'elysia';
import type { Pool } from 'pg';
import { readNativeAccountStates } from '../access/account-authority.ts';
import { readExplicitExposureGrant } from '../access/index.ts';
import { throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, type Admission, type JobContext } from '../http/request.ts';
import { AuthenticationError, type AccessCheck, type Actor, type Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { createApp } from '../http/app.ts';
import type { EconomyResult, EconomyWalletPort } from './contract.ts';

type WalletScope = {
  actor: Actor;
  authorize(resource: Resource): Promise<AccessCheck>;
  admission: Admission;
  job: JobContext;
};
const closed = { additionalProperties: false } as const;
const assetId = t.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' });
const amount = t.String({ maxLength: 19, pattern: '^(?:0|[1-9][0-9]*)$' });
const positive = t.String({ maxLength: 19, pattern: '^[1-9][0-9]*$' });
const signed = t.String({ maxLength: 20, pattern: '^(?:0|-?[1-9][0-9]*)$' });
const params = t.Object({ assetId }, closed);
const asset = t.Object({ id: assetId, scale: t.Integer(), transferable: t.Boolean() }, closed);
const balance = t.Object(
  {
    asset,
    posted: amount,
    held: amount,
    restricted: amount,
    pending: t.String({ maxLength: 39, pattern: '^(?:0|[1-9][0-9]*)$' }),
    available: amount,
  },
  closed,
);
const operationId = t.String({ minLength: 1, maxLength: 255 });
const entry = t.Object(
  {
    position: positive,
    operationId,
    kind: t.Union([
      t.Literal('issue'),
      t.Literal('transfer'),
      t.Literal('reserve'),
      t.Literal('capture'),
      t.Literal('release'),
      t.Literal('expire'),
      t.Literal('deposit'),
      t.Literal('withdrawal'),
      t.Literal('withdrawal_return'),
      t.Literal('chargeback'),
      t.Literal('withdrawal_refusal'),
      t.Literal('redeem'),
      t.Literal('credit_expiry'),
    ]),
    postedDelta: signed,
    heldDelta: signed,
    recordedAt: t.String({ format: 'date-time' }),
  },
  closed,
);
const statement = t.Object({ entries: t.Array(entry, { maxItems: 100 }), next: t.Union([positive, t.Null()]) }, closed);

function detail(operation: string, action: 'wallet:read' | 'wallet:transfer') {
  return {
    operationId: operation,
    'x-exposure': 'gate:economy',
    'x-action': action,
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': ['access.account'],
    security: [{ bearerAuth: [] }],
  };
}

function failures() {
  return {
    400: problemSchema('invalid_request'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden', 'platform_closed', 'account_suspended'),
    404: problemSchema('not_found'),
    409: problemSchema('conflict'),
    422: problemSchema('idempotency_conflict'),
    429: problemSchema('rate_limited'),
    503: problemSchema('dependency_unavailable', 'deadline_exceeded', 'overloaded', 'partition_unavailable'),
  };
}

function valueOf<T>(result: EconomyResult<T>): T {
  switch (result.kind) {
    case 'ok':
      return result.value;
    case 'asset_missing':
      throw new ProblemError('not_found');
    case 'operation_conflict':
      throw new ProblemError('idempotency_conflict');
    case 'insufficient_funds':
      throw new ProblemError('conflict', { detail: 'Insufficient available balance.' });
    case 'program_ineligible':
    case 'program_expired':
    case 'program_supply_exceeded':
      throw new ProblemError('conflict', { detail: 'The asset programme does not admit this operation.' });
    case 'asset_not_transferable':
      throw new ProblemError('conflict', { detail: 'This asset cannot be transferred.' });
    case 'invalid_amount':
    case 'invalid_operation':
      throw new ProblemError('invalid_request');
    case 'hold_missing':
    case 'hold_closed':
    case 'allocation_missing':
    case 'allocation_closed':
    case 'unavailable':
      throw new ProblemError('dependency_unavailable');
  }
}

async function requireWalletOwner(pool: Pool, { actor, authorize, job, admission }: WalletScope): Promise<string> {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const route = routeOf(actor.accountId);
  if (route === null) throw new ProblemError('forbidden');
  try {
    const check = await authorize({ route, id: actor.accountId });
    const allowed = await admission.run('normal', job, () => withBoundedReadConnection(pool, job.deadline, check));
    if (!allowed) throw new ProblemError('forbidden');
    return actor.accountId;
  } catch (error) {
    throwAccessUnavailable(error, job.deadline);
    throw error;
  }
}

async function requireActiveRecipient(pool: Pool, deadline: number, recipientId: string): Promise<void> {
  if (routeOf(recipientId) === null) throw new ProblemError('not_found');
  try {
    const admitted = await withBoundedReadConnection(pool, deadline, async (client) => {
      const [recipient] = await readNativeAccountStates(client, [recipientId]);
      if (recipient?.state !== 'active' || recipient.fenced) return false;
      return readExplicitExposureGrant(client, 'economy', recipientId);
    });
    if (!admitted) throw new ProblemError('not_found');
  } catch (error) {
    throwAccessUnavailable(error, deadline);
    throw error;
  }
}

export function economyRoutes(app: ReturnType<typeof createApp>, deps: { pool: Pool; economy?: EconomyWalletPort }) {
  const port = () => {
    if (!deps.economy) throw new ProblemError('dependency_unavailable');
    return deps.economy;
  };

  return app
    .get(
      '/v1/economy/wallets/:assetId',
      {
        params,
        response: { 200: balance, ...failures() },
        detail: detail('wallet.read', 'wallet:read'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        const accountId = await requireWalletOwner(deps.pool, ctx);
        return ctx.admission.run('normal', ctx.job, async () =>
          valueOf(await port().readBalance({ accountId, assetId: ctx.params.assetId })),
        );
      },
    )
    .get(
      '/v1/economy/wallets/:assetId/statement',
      {
        params,
        query: t.Object(
          { before: t.Optional(positive), limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })) },
          closed,
        ),
        response: { 200: statement, ...failures() },
        detail: detail('wallet.read_statement', 'wallet:read'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        const accountId = await requireWalletOwner(deps.pool, ctx);
        return ctx.admission.run('normal', ctx.job, async () => {
          const value = valueOf(
            await port().readStatement({
              accountId,
              assetId: ctx.params.assetId,
              limit: ctx.query.limit ?? 20,
              ...(ctx.query.before === undefined ? {} : { before: ctx.query.before }),
            }),
          );
          return { entries: [...value.entries], next: value.next };
        });
      },
    )
    .post(
      '/v1/economy/wallets/:assetId/transfers',
      {
        params,
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }),
        body: t.Object({ recipientId: t.String({ format: 'uuid' }), amount: positive }, closed),
        response: { 200: t.Object({ operationId }, closed), ...failures() },
        detail: detail('wallet.transfer', 'wallet:transfer'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        const accountId = await requireWalletOwner(deps.pool, ctx);
        const key = idempotencyKeyOf(ctx.headers[IDEMPOTENCY_HEADER]);
        const recipientId = ctx.body.recipientId.toLowerCase();
        if (recipientId === accountId) throw new ProblemError('invalid_request');
        return ctx.admission.run('normal', ctx.job, async () => {
          const wallet = port();
          await requireActiveRecipient(deps.pool, ctx.job.deadline, recipientId);
          return valueOf(
            await wallet.transfer({
              accountId,
              assetId: ctx.params.assetId,
              recipientId,
              amount: ctx.body.amount,
              operationId: key,
            }),
          );
        });
      },
    );
}
