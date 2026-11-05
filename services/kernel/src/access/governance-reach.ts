import { hasLiveCommandTransaction, registerCommandCallback, type CommandTransaction } from '../command/command.ts';
import type { Access, AccessClient, Actor, Resource } from '../request/access.ts';
import recordGovernanceReach from './governance-reach-record.sql';
import governance from '../events/contracts/access-platform-governance.json';

export const PLATFORM_RESOURCE = Object.freeze({
  route: 0,
  id: '00000000-0000-8000-8000-000000000000',
} as const);

const actions = new Set<string>(governance.globalReach);
const reached = new WeakMap<object, readonly Resource[]>();
const registered = new WeakMap<CommandTransaction, Set<string>>();

export type GovernanceReachUse = Readonly<{
  actorAccountId: string;
  action: string;
  resource: Readonly<Resource>;
  resources: readonly Readonly<Resource>[];
}>;

export function isGlobalReachAction(action: string): boolean {
  return actions.has(action);
}

export function isPlatformResource(resource: Resource): boolean {
  return resource.route === PLATFORM_RESOURCE.route && resource.id === PLATFORM_RESOURCE.id;
}

/** Set only after the sole formula permits every resource of the bound page. */
export function setGovernanceReach(evidence: unknown, resources: readonly Resource[]): void {
  if (typeof evidence === 'object' && evidence !== null)
    reached.set(evidence, Object.freeze(resources.map((resource) => Object.freeze({ ...resource }))));
}

export function usedGovernanceReach(evidence: unknown): boolean {
  return typeof evidence === 'object' && evidence !== null && (reached.get(evidence)?.length ?? 0) > 0;
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
    resources: reached.get(evidence as object)!,
  });
}

/** Register one reach row for this action/resource/actor in a live command.
 * Returning false lets command authorizers fail closed when no transaction can
 * carry the record. The SQL callback runs only after body/finalizer success.
 */
export function recordGovernanceReachUse(tx: CommandTransaction, use: GovernanceReachUse): boolean {
  if (!hasLiveCommandTransaction(tx)) return false;
  const key = JSON.stringify([
    use.action,
    use.resource.route,
    use.resources.map((resource) => resource.id).sort(),
    use.actorAccountId,
  ]);
  const uses = registered.get(tx) ?? new Set<string>();
  if (uses.has(key)) return true;
  try {
    registerCommandCallback(tx, (transactionId) =>
      recordGovernanceReach.run(tx, {
        route: use.resource.route,
        transaction_id: transactionId,
        action: use.action,
        resource_ids: use.resources.map((resource) => resource.id),
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
