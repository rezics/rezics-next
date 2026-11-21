import { t } from 'elysia';
import { PLATFORM_RESOURCE } from '../access/bootstrap-governance.ts';
import type { CommandAuthorization, CommandOutcome } from '../command/command.ts';
import type { createApp } from '../http/app.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { AuthenticationError, type Actor } from '../request/access.ts';

export type MarketRepairAcceptance = Readonly<{ reconciliation: 'queued' }>;
export type EconomyMarketRepairPort = Readonly<{
  request(
    input: Readonly<{
      actor: Extract<Actor, { kind: 'account' }>;
      tradeId: string;
      key: string;
      deadline: number;
      authorization: CommandAuthorization;
    }>,
  ): Promise<CommandOutcome<MarketRepairAcceptance>>;
}>;

const closed = { additionalProperties: false } as const;

export function economyMarketRepairRoutes(app: ReturnType<typeof createApp>, port: EconomyMarketRepairPort) {
  return app.post(
    customMethod('/v1/economy/market/trades/:tradeId', 'repair'),
    {
      params: t.Object({ tradeId: t.String({ pattern: '^[0-9a-f]{64}$' }) }, closed),
      headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }),
      body: t.Object({}, closed),
      response: {
        202: t.Object({ reconciliation: t.Literal('queued') }, closed),
        400: problemSchema('invalid_request'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden', 'platform_closed', 'account_suspended'),
        404: problemSchema('not_found'),
        422: problemSchema('idempotency_conflict'),
        429: problemSchema('rate_limited'),
        503: problemSchema(
          'dependency_unavailable',
          'deadline_exceeded',
          'overloaded',
          'partition_unavailable',
          'transaction_retry_exhausted',
          'rate_limit_unavailable',
        ),
      },
      detail: {
        operationId: 'market.repair_trade',
        'x-exposure': 'gate:economy',
        'x-action': 'market:repair',
        'x-authority-resource-types': ['semantic.context'],
        'x-authority-resource-id': PLATFORM_RESOURCE.id,
        'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
        security: [{ bearerAuth: [] }],
      },
    },
    async ({ actor, params, headers, job, admission, authorizeCommand, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      if (!actor.scopes.includes('market:repair')) throw new ProblemError('forbidden');
      const authorization = await authorizeCommand(PLATFORM_RESOURCE, () => new ProblemError('forbidden'));
      const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
      const result = await admission.run('normal', job, () =>
        port.request({ actor, tradeId: params.tradeId, key, authorization, deadline: job.deadline }),
      );
      session.record(result);
      set.headers['cache-control'] = 'private, no-store';
      set.status = 202;
      return result.value;
    },
  );
}
