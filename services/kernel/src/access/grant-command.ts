import { accessClock } from './access-clock.ts';
import { requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  runCommand,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { type Access, type AccessContext, type AccessCheck, type Actor, type Resource } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import { commandAccessContext, requireCommandAdmission } from './command-admission.ts';
import { prepareGovernanceCheck } from './governance-reach.ts';

/** Only kernel-authenticated actor objects belong in this context; request JSON
 * supplies the command input, never this context or an authorization decision.
 */
export type GrantCommandContext = AccessContext & { actor: Actor };
export function validResource(resource: Resource): boolean {
  return resource && routeOf(resource.id) !== null && routeOf(resource.id) === resource.route;
}
export function validActions(actions: readonly string[]): boolean {
  return (
    Array.isArray(actions) &&
    actions.length > 0 &&
    actions.length <= 1000 &&
    actions.every(
      (action) =>
        typeof action === 'string' &&
        (/^[a-z][a-z_]*:[a-z][a-z_]*$/.test(action) || (action !== 'gate:any' && GATE_GROUP.test(action))),
    )
  );
}

/** `<group>` in `gate:<group>`. `gate:any` is the covering action, not a group. */
const GATE_GROUP = /^gate:[a-z][a-z_]{0,62}$/;

function isGlobalContext(resource: Resource): boolean {
  return resource.route === PLATFORM_RESOURCE.route && resource.id === PLATFORM_RESOURCE.id;
}

function delegableGate(action: string): boolean {
  return action !== 'gate:any' && GATE_GROUP.test(action);
}

/** Prepare separate anchors before resource checkout, then reuse the original
 * Access evaluator on the same SERIALIZABLE client on every command attempt.
 * Access enforces real evidence budgets at authorization; the command deadline
 * also bounds mutation completion. Authorization runs before receipt lookup at
 * the executor's trusted T, including on replay. A mutation may remove its own
 * grantor rights.
 */
export async function grantCommand<T>(
  config: { pool: Pool; access: Access; clock?: (() => Date) | undefined },
  context: GrantCommandContext,
  options: {
    resource: Resource;
    actions: readonly string[];
    consentedActions?: readonly string[];
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
  const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
  const proofs = new WeakMap<
    object,
    { attempt: CommandAttempt; checks: { action: string; evidence: unknown; check: AccessCheck }[] }
  >();
  const authorization: CommandAuthorization = {
    action: options.actions[0]!,
    resource: Object.freeze({ ...options.resource }),
    denied: options.denied,
    async prepare(attempt) {
      try {
        const preparation = commandAccessContext(context, attempt);
        await requireCommandAdmission(config.access, actor, preparation);
        if (options.consentedActions?.some((action) => !actor.scopes.includes(action))) throw options.denied();
        const actions = [...new Set(options.actions)];
        const checks: { action: string; evidence: unknown; check: AccessCheck }[] = [];
        for (const action of actions)
          checks.push({
            action,
            ...(await prepareGovernanceCheck(config.access, actor, action, options.resource, preparation)),
          });
        // Holding gate:any covers every gate:<group> on the Global Context. One
        // extra exact check, reused across those actions, is the whole exception.
        // gate:any itself stays exact. No other action gains a wildcard.
        const groups = isGlobalContext(options.resource) ? actions.filter(delegableGate) : [];
        if (groups.length > 0) {
          const gateAnyIndex = actions.indexOf('gate:any');
          const gateAny =
            gateAnyIndex >= 0
              ? checks[gateAnyIndex]!.check
              : (await prepareGovernanceCheck(config.access, actor, 'gate:any', PLATFORM_RESOURCE, preparation)).check;
          let covered: Promise<boolean> | undefined;
          for (const action of groups) {
            const index = actions.indexOf(action);
            const held = checks[index]!.check;
            checks[index]!.check = async (client, time) => {
              if (await held(client, time)) return true;
              covered ??= gateAny(client, time);
              return covered;
            };
          }
        }
        const proof = Object.freeze({});
        proofs.set(proof, { attempt, checks });
        return proof;
      } catch (error) {
        throwAccessUnavailable(error, context.deadline);
        throw options.denied();
      }
    },
    async authorize(tx, attempt, proof) {
      const prepared = typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
      if (typeof proof === 'object' && proof !== null) proofs.delete(proof);
      if (!prepared || prepared.attempt !== attempt) throw options.denied();
      if (
        attempt.basis?.actorAccountId !== basis.actorAccountId ||
        attempt.basis.clientId !== basis.clientId ||
        attempt.basis.requestedBy !== basis.requestedBy
      )
        throw options.denied();
      for (const check of prepared.checks) if (!(await check.check(tx, attempt.time))) throw options.denied();
      requireAccessDeadline(context.deadline);
      return 'execute';
    },
  };
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
        authorization,
        clock: config.clock ?? accessClock(config.access),
        receipt: {
          actorAccountId: actor.accountId,
          kind: options.kind,
          key: `${options.resource.route}:${options.key}`,
          digest,
        },
      },
      async (tx, { transactionId }) => {
        if (conflict !== undefined) throw conflict;
        requireAccessDeadline(context.deadline);
        const value = await mutate(tx, transactionId);
        requireAccessDeadline(context.deadline);
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
