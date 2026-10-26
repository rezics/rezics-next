import { hasLiveCommandTransaction, registerCommandCallback, type CommandTransaction } from '../command/command.ts';
import type { Access, AccessClient, Actor, Resource } from '../request/access.ts';
import recordGovernanceReach from './governance-reach-record.sql';
import governance from './platform-governance.json';

export const PLATFORM_RESOURCE = Object.freeze({
  route: 0,
  id: '00000000-0000-8000-8000-000000000000',
} as const);

const actions = new Set<string>(governance.globalReach);
const reached = new WeakMap<object, boolean>();
const registered = new WeakMap<CommandTransaction, Set<string>>();

export type GovernanceReachUse = Readonly<{
  actorAccountId: string;
  action: string;
  resource: Readonly<Resource>;
}>;

export function isGlobalReachAction(action: string): boolean {
  return actions.has(action);
}

export function isPlatformResource(resource: Resource): boolean {
  return resource.route === PLATFORM_RESOURCE.route && resource.id === PLATFORM_RESOURCE.id;
}

/** Run R's formula first, then the exact same action on the Global Context only
 * after an ordinary denial. A missing or failed local result cannot fall through.
 */
export async function checkWithGovernanceReach(
  evidence: unknown,
  action: string,
  resource: Resource,
  ordinary: () => Promise<boolean | undefined>,
  global: () => Promise<boolean | undefined>,
): Promise<boolean> {
  if (typeof evidence === 'object' && evidence !== null) reached.set(evidence, false);
  const allowed = await ordinary();
  if (allowed === true) return true;
  if (allowed !== false || isPlatformResource(resource) || !isGlobalReachAction(action)) return false;
  const globalAllowed = await global();
  if (globalAllowed === true && typeof evidence === 'object' && evidence !== null) reached.set(evidence, true);
  return globalAllowed === true;
}

export function usedGovernanceReach(evidence: unknown): boolean {
  return typeof evidence === 'object' && evidence !== null && reached.get(evidence) === true;
}

/** Retain the exact write attribution when an opaque permission proof used the
 * Global Context. The caller must record this use in its command transaction.
 */
export function governanceReachUse(
  evidence: unknown,
  actor: Actor,
  action: string,
  resource: Resource,
): GovernanceReachUse | undefined {
  if (actor.kind !== 'account' || !usedGovernanceReach(evidence)) return undefined;
  return Object.freeze({
    actorAccountId: actor.accountId,
    action,
    resource: Object.freeze({ route: resource.route, id: resource.id }),
  });
}

/** Register one reach row for this action/resource/actor in a live command.
 * Returning false lets command authorizers fail closed when no transaction can
 * carry the record. The SQL callback runs only after body/finalizer success.
 */
export function recordGovernanceReachUse(tx: CommandTransaction, use: GovernanceReachUse): boolean {
  if (!hasLiveCommandTransaction(tx)) return false;
  const key = JSON.stringify([use.action, use.resource.route, use.resource.id, use.actorAccountId]);
  const uses = registered.get(tx) ?? new Set<string>();
  if (uses.has(key)) return true;
  try {
    registerCommandCallback(tx, (transactionId) =>
      recordGovernanceReach.run(tx, {
        route: use.resource.route,
        transaction_id: transactionId,
        action: use.action,
        resource_id: use.resource.id,
        actor_account_id: use.actorAccountId,
      }),
    );
  } catch {
    return false;
  }
  uses.add(key);
  registered.set(tx, uses);
  return true;
}

/** Prepare one exact Access check while retaining only the opaque evidence
 * handle needed to report whether that check used platform governance reach.
 */
export async function prepareGovernanceCheck(
  access: Access,
  actor: Actor,
  action: string,
  resource: Resource,
  context: Parameters<NonNullable<Access['prepare']>>[3],
): Promise<{
  evidence: unknown;
  check: (client: AccessClient, time?: Parameters<Access['authorize']>[5]) => Promise<boolean>;
}> {
  const evidence = access.prepare ? await access.prepare(actor, action, resource, context) : null;
  return {
    evidence,
    check: (client, time) => access.authorize(client, actor, action, resource, evidence, time),
  };
}
