import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
  type CommandOutcome,
} from '../command/command.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';

const SERVICE_ID = '00000000-0000-8000-8000-000000000001';
import { LifecycleDeniedError } from './contract/errors.ts';
export { LifecycleDeniedError } from './contract/errors.ts';
function requireAllowed(value: unknown): asserts value {
  if (!value) throw new LifecycleDeniedError();
}
type Mutation = {
  route: number;
  id: string;
  kind: string;
  key: string;
  input: unknown;
  additionalEvents?: () => Array<{ type: string; subject?: string; data: unknown }>;
  actor?: AccountActor;
  deadline?: number;
  authorization?: CommandAuthorization;
};
export type LifecycleReceipt = { key: string; digest: string };

/** All idempotency digests include the anchor, actual kernel actor/client and
 * requested_by. Core's partition receipt key is explicitly prefixed by route.
 * Responses/events contain identity and coordination facts, never patch bodies.
 */
export function lifecycleExecutor(pool: Pool, clock?: () => Date) {
  return async function execute<T>(
    options: Mutation,
    body: (tx: CommandTransaction, transactionId: string, receipt: LifecycleReceipt) => Promise<T>,
  ): Promise<CommandOutcome<T>> {
    requireAllowed(typeof options.key === 'string' && options.key.length > 0 && options.key.length <= 256);
    const actor = options.actor;
    requireAllowed(!actor || options.authorization);
    const basis = {
      actorAccountId: actor?.accountId ?? SERVICE_ID,
      clientId: actor?.clientId ?? 'internal-access',
      requestedBy: actor?.requestedBy ?? null,
    };
    const digest = createHash('sha256')
      .update(canonicalize([options.route, options.id, options.kind, basis, options.input])!)
      .digest();
    const outcome = await runCommand(
      pool,
      {
        partition: partitionOf(options.route),
        ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
        basis,
        clock,
        authorization: options.authorization,
        receipt: {
          actorAccountId: basis.actorAccountId,
          kind: `access.${options.kind}`,
          key: `${options.route}:${options.key}`,
          digest,
        },
      },
      async (tx, { transactionId }) => {
        const value = await body(tx, transactionId, {
          key: `${options.route}:${options.key}`,
          digest: digest.toString('hex'),
        });
        return {
          value,
          events: [
            { type: `com.rezics.access.${options.kind}.v1`, subject: options.id, data: value },
            ...(options.additionalEvents?.() ?? []),
          ],
        };
      },
    );
    // Expose snapshots: callers cannot accidentally mutate the response retained
    // by a workflow while passing receipt objects to another service boundary.
    return {
      ...outcome,
      get value() {
        return structuredClone(outcome.value);
      },
    };
  };
}
