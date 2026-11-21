import { t } from 'elysia';
import type { Pool } from 'pg';
import { throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import type { createApp } from '../http/app.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, type Admission, type JobContext } from '../http/request.ts';
import { AuthenticationError, type AccessCheck, type Actor, type Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

type Request = Readonly<{ accountId: string; deadline: number }>;
type FundingDirection = 'deposit' | 'withdrawal';
type FundingPhase = 'awaiting_hold' | 'ready' | 'submitted' | 'unknown' | 'refused' | 'confirmed' | 'reversed';

type FundingIntentView = Readonly<{
  intentId: string;
  assetId: string;
  direction: FundingDirection;
  amount: string;
  phase: FundingPhase;
  reversedAmount: string;
}>;

export interface EconomyTestFundingPort {
  begin(
    input: Request & { operationId: string; direction: FundingDirection; amount: string },
  ): Promise<{ intentId: string }>;
  read(input: Request & { intentId: string }): Promise<FundingIntentView>;
}

type FundingScope = {
  actor: Actor;
  authorize(resource: Resource): Promise<AccessCheck>;
  admission: Admission;
  job: JobContext;
};

const closed = { additionalProperties: false } as const;
const intentId = t.String({ minLength: 64, maxLength: 64, pattern: '^[0-9a-f]+$' });
const direction = t.Union([t.Literal('deposit'), t.Literal('withdrawal')]);
const positiveAmount = t.String({ maxLength: 19, pattern: '^[1-9][0-9]*$' });
const reversedAmount = t.String({ maxLength: 19, pattern: '^(?:0|[1-9][0-9]*)$' });
const phase = t.Union([
  t.Literal('awaiting_hold'),
  t.Literal('ready'),
  t.Literal('submitted'),
  t.Literal('unknown'),
  t.Literal('refused'),
  t.Literal('confirmed'),
  t.Literal('reversed'),
]);
const intentView = t.Object(
  {
    intentId,
    direction,
    amount: positiveAmount,
    phase,
    reversedAmount,
    assetId: t.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' }),
  },
  closed,
);

function detail(operationId: string) {
  return {
    operationId,
    'x-exposure': 'gate:economy',
    'x-action': 'wallet:test_funding',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': ['access.account'],
    security: [{ bearerAuth: [] }],
  };
}

function failures() {
  return {
    400: problemSchema('invalid_request'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('platform_closed', 'account_suspended', 'forbidden'),
    404: problemSchema('not_found'),
    409: problemSchema('conflict'),
    422: problemSchema('idempotency_conflict'),
    429: problemSchema('rate_limited'),
    503: problemSchema('dependency_unavailable', 'deadline_exceeded', 'overloaded', 'partition_unavailable'),
  };
}

export function economyTestFundingRoutes(
  app: ReturnType<typeof createApp>,
  deps: { pool: Pool; testFunding: EconomyTestFundingPort },
) {
  async function run<Value>(
    ctx: FundingScope,
    work: (port: EconomyTestFundingPort, request: Request) => Promise<Value>,
  ) {
    const { actor, authorize, admission, job } = ctx;
    if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
    const route = routeOf(actor.accountId);
    if (route === null) throw new ProblemError('forbidden');
    try {
      const check = await authorize({ route, id: actor.accountId });
      return await admission.run('normal', job, async () => {
        if (!(await withBoundedReadConnection(deps.pool, job.deadline, check))) throw new ProblemError('forbidden');
        return work(deps.testFunding, { accountId: actor.accountId, deadline: job.deadline });
      });
    } catch (error) {
      throwAccessUnavailable(error, job.deadline);
      throw error;
    }
  }

  return app
    .post(
      '/v1/economy/test-funding/intents',
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }),
        body: t.Object({ direction, amount: positiveAmount }, closed),
        response: { 200: t.Object({ intentId }, closed), ...failures() },
        detail: detail('wallet_test_funding.begin'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return run(ctx, (port, request) =>
          port.begin({
            ...request,
            ...ctx.body,
            operationId: idempotencyKeyOf(ctx.headers[IDEMPOTENCY_HEADER]),
          }),
        );
      },
    )
    .get(
      '/v1/economy/test-funding/intents/:intentId',
      {
        params: t.Object({ intentId }, closed),
        response: { 200: intentView, ...failures() },
        detail: detail('wallet_test_funding.read'),
      },
      async (ctx) => {
        ctx.set.headers['cache-control'] = 'private, no-store';
        return run(ctx, (port, request) => port.read({ ...request, intentId: ctx.params.intentId }));
      },
    );
}
