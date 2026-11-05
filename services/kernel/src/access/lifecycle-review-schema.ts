import { t } from 'elysia';
import type { LifecycleReview } from './lifecycle-review-contract.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const pageKey = t.String({ pattern: '^[0-9a-f]{64}$' });
const progress = t.Union([t.Literal('complete'), t.Literal('pending'), t.Literal('unknown')]);
const effects = t.Object(
  {
    state: progress,
    sessionRevocation: t.Union([t.Literal('unknown'), t.Literal('not_required')]),
    sessionRevocationAuthorization: t.Union([t.Literal('recorded'), t.Literal('unknown'), t.Literal('not_required')]),
    accountAgentSynchronization: t.Literal('unknown'),
    operator: progress,
    inspectedPages: t.Integer({ minimum: 0, maximum: 1 }),
    terminalSubjects: t.Integer({ minimum: 0, maximum: 100 }),
    operatorPage: t.Optional(
      t.Object(
        {
          state: t.Union([t.Literal('complete'), t.Literal('pending')]),
          nextPageKey: t.Union([pageKey, t.Null()]),
        },
        closed,
      ),
    ),
  },
  closed,
);

/** Runtime allowlist as well as the named client projection: no private command payload can escape. */
export const lifecycleReviewSchema = t.Unsafe<LifecycleReview>(
  t.Object(
    {
      account: t.Object(
        {
          id,
          kind: t.Union([t.Literal('actor'), t.Literal('organization')]),
          displayName: t.Union([t.String({ maxLength: 1024 }), t.Null()]),
          handle: t.Union([t.String({ maxLength: 64 }), t.Null()]),
        },
        closed,
      ),
      current: t.Object(
        {
          state: t.Union([t.Literal('pending'), t.Literal('active'), t.Literal('suspended'), t.Literal('deleted')]),
          minimumAuthnEpoch: t.String({ pattern: '^[1-9][0-9]{0,18}$' }),
          fenced: t.Boolean(),
        },
        closed,
      ),
      actions: t.Array(
        t.Union([
          t.Object({ action: t.Literal('account:suspend'), operationId: t.Literal('account.suspend') }, closed),
          t.Object({ action: t.Literal('account:reinstate'), operationId: t.Literal('account.reinstate') }, closed),
        ]),
        { maxItems: 2 },
      ),
      original: t.Optional(
        t.Union([
          t.Object({ status: t.Literal('unknown') }, closed),
          t.Object({ status: t.Literal('recorded'), receiptId: id, effects }, closed),
        ]),
      ),
    },
    closed,
  ),
);
