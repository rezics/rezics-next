import { memoizedValue } from '../memoized.ts';
import { MoneyInterpretationUnavailable } from './royalty.ts';
import { randomBytes } from 'node:crypto';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Access, Actor } from '../request/access.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import readContext from '../semantic/read-context.sql';
import { createPayouts, listPayoutLines, listPayoutStatements, readPayoutStatement } from './payouts.ts';

const amount = t.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const id = t.String({ format: 'uuid' });
const moneyUnit = t.Optional(
  t.Union([
    t.Object(
      {
        system: t.Literal('stripe-api'),
        exponent: t.Union([t.Literal(0), t.Literal(2)]),
        factsVersion: t.Literal('stripe-money-v1'),
      },
      { additionalProperties: false },
    ),
    t.Null(),
  ]),
);
const statement = t.Object(
  {
    id,
    creatorAccountId: id,
    period: t.String({ pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' }),
    currency: t.String(),
    moneyUnit,
    grossMinor: amount,
    taxMinor: amount,
    feeMinor: amount,
    disputeFeeMinor: amount,
    refundsMinor: amount,
    chargebacksMinor: amount,
    netReceiptsMinor: amount,
    creatorShareMinor: amount,
    rezicsShareMinor: amount,
    weightedNetMinor: t.String({ pattern: '^-?[0-9]+$' }),
    state: t.Union([t.Literal('open'), t.Literal('paid')]),
    paidAt: t.Union([t.String(), t.Null()]),
    paidReference: t.Union([t.String(), t.Null()]),
    revision: t.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const payment = t.Object(
  {
    id,
    state: t.Literal('paid'),
    paidAt: t.String(),
    paidReference: t.String(),
    revision: t.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const line = t.Object(
  {
    balanceTransactionId: t.String(),
    orderId: id,
    offerId: id,
    creatorAccountId: id,
    currency: t.String(),
    moneyUnit,
    kind: t.Union([
      t.Literal('charge'),
      t.Literal('refund'),
      t.Literal('refund_reversal'),
      t.Literal('dispute'),
      t.Literal('dispute_reversal'),
    ]),
    created: t.String(),
    grossMinor: amount,
    taxMinor: amount,
    feeMinor: amount,
    disputeFeeMinor: amount,
    netReceiptsMinor: amount,
    royaltyBasisPoints: t.Integer(),
    period: t.String(),
    statementId: id,
    recordedAt: t.String(),
  },
  { additionalProperties: false },
);
const pageQuery = t.Object({
  cursor: t.Optional(t.String({ maxLength: 4096 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
});
const params = t.Object({ statementId: t.String() });
function unavailable() {
  return memoizedValue(unavailable, () =>
    problemSchema(
      'overloaded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'deadline_exceeded',
      'dependency_unavailable',
    ),
  );
}
function errors() {
  return memoizedValue(errors, () => ({
    400: problemSchema('invalid_request'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    404: problemSchema('not_found'),
    503: unavailable(),
  }));
}
const security = [{ bearerAuth: [] }];
function accountAnchor(actor: Actor) {
  if (actor.kind !== 'account') throw new ProblemError('not_found');
  return { route: routeOf(actor.accountId)!, id: actor.accountId };
}

export function payoutRoutes(
  app: ReturnType<typeof definitionRoutes>,
  {
    pool,
    access,
    tokens = { current: 1, keys: new Map([[1, new Uint8Array(randomBytes(32))]]) },
  }: { pool: Pool; access: () => Access; tokens?: KeyRing },
) {
  const payouts = createPayouts({ pool });
  return app
    .get(
      '/v1/payoutStatements',
      {
        query: pageQuery,
        response: {
          200: t.Object({ payoutStatements: t.Array(statement), next: t.Union([t.String(), t.Null()]) }),
          ...errors(),
          400: problemSchema('invalid_request', 'invalid_cursor'),
          409: problemSchema('stale_cursor'),
        },
        detail: {
          operationId: 'payout_statement.list',
          'x-exposure': 'gate:selling',
          'x-action': 'payout_statement:list',
          security,
        },
      },
      async ({ actor, authorize, query, admission, job }) => {
        const check = await authorize(accountAnchor(actor));
        return admission.run('normal', job, () =>
          listPayoutStatements(pool, tokens, actor, check, { cursor: query.cursor ?? null, limit: query.limit ?? 20 }),
        );
      },
    )
    .get(
      '/v1/payoutStatements/:statementId',
      {
        params,
        response: { 200: t.Object({ statement }), ...errors() },
        detail: {
          operationId: 'payout_statement.get',
          'x-exposure': 'gate:selling',
          'x-action': 'payout_statement:read',
          security,
        },
      },
      async ({ actor, authorize, params, admission, job }) => {
        const check = await authorize(accountAnchor(actor));
        return {
          statement: await admission.run('normal', job, () =>
            readPayoutStatement(pool, actor, params.statementId, check),
          ),
        };
      },
    )
    .get(
      '/v1/payoutStatements/:statementId/lines',
      {
        params,
        query: pageQuery,
        response: {
          200: t.Object({ lines: t.Array(line), next: t.Union([t.String(), t.Null()]) }),
          ...errors(),
          400: problemSchema('invalid_request', 'invalid_cursor'),
          409: problemSchema('stale_cursor'),
        },
        detail: {
          operationId: 'payout_statement.lines',
          'x-exposure': 'gate:selling',
          'x-action': 'payout_statement:read',
          security,
        },
      },
      async ({ actor, authorize, params, query, admission, job }) => {
        const check = await authorize(accountAnchor(actor));
        return admission.run('normal', job, () =>
          listPayoutLines(pool, tokens, actor, params.statementId, check, {
            cursor: query.cursor ?? null,
            limit: query.limit ?? 20,
          }),
        );
      },
    )
    .post(
      customMethod('/v1/payoutStatements/:statementId', 'markPaid'),
      {
        params,
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: t.Object({ paidReference: t.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
        response: {
          200: t.Object({ statement: payment }),
          ...errors(),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
        },
        detail: {
          operationId: 'payout_statement.mark_paid',
          'x-exposure': 'gate:selling',
          'x-action': 'payout_statement:mark_paid',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        const route = routeOf(params.statementId);
        if (actor.kind !== 'account' || route === null) throw new ProblemError('not_found');
        const authorization = resourceAuthorization({
          access: access(),
          actor,
          action: 'payout_statement:mark_paid',
          anchor: {
            resource: { route: 0, id: GLOBAL_CONTEXT },
            async validate(client) {
              if (!(await readPartition(client, 0))) return false;
              const root = await readContext.run(client, { route: 0, context_id: GLOBAL_CONTEXT });
              return root?.kind === 'global';
            },
          },
          context: { pool, deadline: job.deadline, partition: partitionOf(route) },
        });
        const result = await admission
          .run('normal', job, () =>
            payouts.markPaid(
              actor,
              params.statementId,
              body.paidReference,
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              authorization,
            ),
          )
          .catch((error: unknown) => {
            if (error instanceof MoneyInterpretationUnavailable) throw new ProblemError('dependency_unavailable');
            if (error instanceof GrantDeniedError) throw new ProblemError('not_found');
            throw error;
          });
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return {
          statement: {
            id: result.value.id,
            state: 'paid' as const,
            paidAt: result.value.paidAt!,
            paidReference: result.value.paidReference!,
            revision: result.value.revision,
          },
        };
      },
    );
}
