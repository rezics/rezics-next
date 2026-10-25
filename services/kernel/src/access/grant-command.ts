import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { runCommand, type CommandTransaction } from '../command/command.ts';
import {
  accessCheck,
  type Access,
  type AccessContext,
  type AccessClient,
  type Actor,
  type Resource,
} from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';

/** Only kernel-authenticated actor objects belong in this context; request JSON
 * supplies the command input, never this context or an authorization decision.
 */
export type GrantCommandContext = AccessContext & { actor: Actor };
export function validResource(resource: Resource): boolean {
  return resource && routeOf(resource.id) !== null && routeOf(resource.id) === resource.route;
}
export function validActions(actions: readonly string[]): boolean {
  return Array.isArray(actions) && actions.length > 0 && actions.every((action) => typeof action === 'string');
}

/** Prepare separate anchors before resource checkout, then reuse the original
 * Access evaluator on the same SERIALIZABLE client on every command attempt.
 * Access enforces real evidence budgets at authorization; the command deadline
 * also bounds mutation completion. A mutation may remove its own grantor rights.
 */
export async function grantCommand<T>(
  config: { pool: Pool; access: Access },
  context: GrantCommandContext,
  options: {
    resource: Resource;
    actions: readonly string[];
    kind: string;
    key: string;
    input: unknown;
    denied: () => Error;
  },
  mutate: (tx: CommandTransaction, transactionId: string) => Promise<T>,
) {
  const { actor } = context;
  if (
    actor.kind !== 'account' ||
    context.pool !== config.pool ||
    !validResource(options.resource) ||
    typeof options.key !== 'string' ||
    !options.key.length ||
    options.key.length > 256
  )
    throw options.denied();
  const checks: ((client: AccessClient) => Promise<boolean>)[] = [];
  for (const action of new Set(options.actions))
    checks.push(await accessCheck(config.access, actor, action, options.resource, context));
  const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
  const digest = createHash('sha256')
    .update(canonicalize([options.resource, options.kind, basis, options.input])!)
    .digest();
  const attempt = (conflict?: unknown) =>
    runCommand(
      config.pool,
      {
        partition: partitionOf(options.resource.route),
        deadline: context.deadline,
        basis,
        receipt: {
          actorAccountId: actor.accountId,
          kind: options.kind,
          key: `${options.resource.route}:${options.key}`,
          digest,
        },
      },
      async (tx, { transactionId }) => {
        if (conflict !== undefined) throw conflict;
        for (const check of checks) if (!(await check(tx))) throw options.denied();
        if (Date.now() >= context.deadline) throw options.denied();
        const value = await mutate(tx, transactionId);
        if (Date.now() >= context.deadline) throw options.denied();
        return {
          value,
          events: [{ type: `com.rezics.${options.kind}.v1`, subject: options.resource.id, data: value }],
        };
      },
    );
  try {
    return await attempt();
  } catch (error) {
    // Concurrent inserts can reach a native exclusion/identity constraint before
    // the partition fence. Start a fresh runCommand transaction so its existing
    // receipt lookup can settle a duplicate. If no receipt exists, throw the
    // original constraint error without repeating the mutation. The same real
    // command deadline bounds this final receipt lookup.
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === '23P01' || code === '23505') return attempt(error);
    throw error;
  }
}
