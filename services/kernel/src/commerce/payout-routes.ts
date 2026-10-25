import { randomBytes } from 'node:crypto';
import { t } from 'elysia';
import type { Pool } from 'pg';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { createPayouts, listPayoutLines, listPayoutStatements, readPayoutStatement } from './payouts.ts';

const amount = t.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const id = t.String({ format: 'uuid' });
const statement = t.Object(
  {
    id,
    creatorAccountId: id,
    period: t.String({ pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' }),
    currency: t.String(),
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
const unavailable = problemSchema(
  'overloaded',
  'partition_unavailable',
  'transaction_retry_exhausted',
  'deadline_exceeded',
);
const errors = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  503: unavailable,
};
const security = [{ bearerAuth: [] }];
function accountAnchor(actor: Actor) {
  if (actor.kind !== 'account') throw new ProblemError('not_found');
  return { route: routeOf(actor.accountId)!, id: actor.accountId };
}

export function payoutRoutes(
  app: ReturnType<typeof definitionRoutes>,
  {
    pool,
    tokens = { current: 1, keys: new Map([[1, new Uint8Array(randomBytes(32))]]) },
  }: { pool: Pool; tokens?: KeyRing },
) {
  const payouts = createPayouts({ pool });
  return app
    .get(
      '/v1/payoutStatements',
      {
        query: pageQuery,
        response: {
          200: t.Object({ payoutStatements: t.Array(statement), next: t.Union([t.String(), t.Null()]) }),
          ...errors,
          400: problemSchema('invalid_request', 'invalid_cursor'),
          409: problemSchema('stale_cursor'),
        },
        detail: { operationId: 'payout_statement.list', 'x-action': 'payout_statement:list', security },
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
        response: { 200: t.Object({ statement }), ...errors },
        detail: { operationId: 'payout_statement.get', 'x-action': 'payout_statement:read', security },
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
          ...errors,
          400: problemSchema('invalid_request', 'invalid_cursor'),
          409: problemSchema('stale_cursor'),
        },
        detail: { operationId: 'payout_statement.lines', 'x-action': 'payout_statement:read', security },
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
          ...errors,
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
        },
        detail: {
          operationId: 'payout_statement.mark_paid',
          'x-action': 'payout_statement:mark_paid',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ actor, authorizeCommand, params, body, headers, admission, job, session }) => {
        if (actor.kind !== 'account') throw new ProblemError('not_found');
        const authorization = await authorizeCommand(
          { route: 0, id: GLOBAL_CONTEXT },
          () => new ProblemError('not_found'),
        );
        const result = await admission.run('normal', job, () =>
          payouts.markPaid(
            actor,
            params.statementId,
            body.paidReference,
            idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            authorization,
          ),
        );
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
