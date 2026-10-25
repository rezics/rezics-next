import type { Account } from './account-data.ts';
import {
  accessCheck,
  AuthenticationError,
  type Access,
  type AccessClient,
  type AccessContext,
  type AccountActor,
  type ActionCatalogue,
  type Actor,
  type Resource,
} from '../request/access.ts';
import candidatesRead from './permission-candidates.sql';
import assignmentRead from './permission-assignment.sql';
import membershipRead from './permission-membership.sql';
import timeRead from './permission-time.sql';
import permissionRead from './permission-check.sql';

/** Kernel-owned request evidence, populated by the one authoritative actor point read.
 * Identity and this record must come from verified Auth/Access, never request JSON.
 */
export type PermissionContext = AccessContext & { account?: Account | null };

export type PermissionConfig = {
  actions: ActionCatalogue;
  /** Retrieve the already-read account from the request; do not query again here. */
  accountEvidence: (actor: AccountActor, context: PermissionContext) => Account | null | undefined;
  authenticate?: Access['authenticate'];
};

type RoleEvidence = { account_id: string; organization_id: string; role: string; valid: string };
type Prepared = {
  binding: string;
  deadline: number;
  databaseDeadline: string;
  principalId: string | null;
  valid: string;
  roles: RoleEvidence[];
  anonymous: boolean;
};

// Object identity is the trust boundary: serialized, spread, and caller-created
// objects can never become evidence. The registry retains no request after GC.
const prepared = new WeakMap<object, Prepared>();
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${uuid}$`);
const requestedByPattern = new RegExp(`^urn:rezics:request:(${uuid}):(${uuid})$`);
const routeOf = (id: string): number => Number.parseInt(id.slice(24, 28), 16);
const bind = (actor: Actor, action: string, resource: Resource): string =>
  JSON.stringify([
    actor.kind,
    actor.kind === 'account'
      ? [actor.accountId, actor.clientId, actor.scopes, actor.requestedBy, actor.authnEpoch]
      : null,
    action,
    resource.route,
    resource.id,
  ]);

function eligible(account: Account, actor: AccountActor): boolean {
  return (
    account.accountId === actor.accountId &&
    account.route === routeOf(actor.accountId) &&
    account.kind === 'actor' &&
    account.state === 'active' &&
    account.fenced === false &&
    Number.isSafeInteger(actor.authnEpoch) &&
    actor.authnEpoch > 0 &&
    BigInt(actor.authnEpoch) >= account.minimumAuthnEpoch
  );
}

/** Runs only the final resource-anchored statement on the command's own client.
 * Reuse through accessCheck so every actual command attempt checks current rows/time.
 */
export async function checkPermission(
  client: AccessClient,
  actor: Actor,
  action: string,
  resource: Resource,
  evidence?: unknown,
): Promise<boolean> {
  try {
    const facts = typeof evidence === 'object' && evidence !== null ? prepared.get(evidence) : undefined;
    if (!facts || facts.binding !== bind(actor, action, resource) || Date.now() >= facts.deadline) return false;
    const row = await permissionRead.run(client, {
      route: resource.route,
      resource_id: resource.id,
      action,
      actor_id: actor.kind === 'account' ? actor.accountId : '',
      principal_id: facts.principalId ?? '',
      anonymous: facts.anonymous,
      roles: facts.roles,
      evidence_valid: facts.valid,
      deadline: facts.databaseDeadline,
    });
    // A query taking longer than its evidence budget cannot produce usable authority.
    return row?.allowed === true && Date.now() < facts.deadline;
  } catch {
    return false;
  }
}

/** Thin Access adapter. Auth and the kernel request hook are separate bindings. */
export function createAccess(config: PermissionConfig): Access {
  // Copy metadata so later mutation of the caller's map cannot expand a mounted catalogue.
  const actions = new Map([...config.actions].map(([action, metadata]) => [action, { ...metadata }]));
  return {
    authenticate:
      config.authenticate ??
      (async () => {
        throw new AuthenticationError(401, 'Bearer error="invalid_token"');
      }),
    async prepare(actor, action, resource, context) {
      const evidence = Object.freeze({});
      try {
        const metadata = actions.get(action);
        if (
          !metadata ||
          !Number.isInteger(resource.route) ||
          resource.route < 0 ||
          resource.route > 65535 ||
          !uuidPattern.test(resource.id) ||
          routeOf(resource.id) !== resource.route ||
          !Number.isFinite(context.deadline) ||
          Date.now() >= context.deadline
        )
          return evidence;
        const binding = bind(actor, action, resource);
        const deadline = Math.min(context.deadline, Date.now() + 1000);
        let account: Account | null | undefined;
        if (actor.kind === 'anonymous') {
          if (!metadata.anonymous) return evidence;
        } else {
          if (
            !uuidPattern.test(actor.accountId) ||
            !actor.clientId ||
            !actor.scopes.includes(action) ||
            actor.scopes.some((scope) => !actions.has(scope))
          )
            return evidence;
          account = config.accountEvidence(actor, context);
          if (!account || !eligible(account, actor)) return evidence;
        }
        // Every query uses the pool independently before resource checkout. None
        // of these reads holds a connection while another partition is consulted.
        const time = await timeRead.run(context.pool);
        if (!time) return evidence;
        const at = time.at;
        let principalId: string | null = null;
        let valid = '(,)';
        const members: { accountId: string; automated: boolean }[] = [];
        if (actor.kind === 'account' && account) {
          members.push({ accountId: actor.accountId, automated: account.operatorAccountId !== null });
          if (actor.requestedBy !== null) {
            const request = requestedByPattern.exec(actor.requestedBy);
            if (!request) return evidence;
            const principal = request[1]!;
            const assignment = await assignmentRead.run(context.pool, {
              route: routeOf(principal),
              principal_id: principal,
              request_id: request[2]!,
              actor_id: actor.accountId,
              at,
            });
            if (
              !assignment ||
              assignment.kind !== 'actor' ||
              assignment.state !== 'active' ||
              assignment.fenced !== false
            )
              return evidence;
            principalId = principal;
            valid = assignment.valid;
            members.push({ accountId: principal, automated: assignment.operatorAccountId !== null });
          }
        }
        const roles: RoleEvidence[] = [];
        if (actor.kind === 'account') {
          const candidates = await candidatesRead.run(context.pool, {
            route: resource.route,
            resource_id: resource.id,
            action,
          });
          for (const candidate of candidates) {
            for (const member of members) {
              if (member.automated) continue;
              const memberships = await membershipRead.run(context.pool, {
                route: routeOf(candidate.organizationId),
                organization_id: candidate.organizationId,
                member_id: member.accountId,
                at,
              });
              if (
                !memberships.length ||
                memberships.some((row) => row.kind !== 'organization' || row.state !== 'active' || row.fenced !== false)
              )
                return evidence;
              roles.push({
                account_id: member.accountId,
                organization_id: candidate.organizationId,
                role: '',
                valid: '(,)',
              });
              for (const membership of memberships)
                if (membership.role && membership.valid)
                  roles.push({
                    account_id: member.accountId,
                    organization_id: candidate.organizationId,
                    role: membership.role,
                    valid: membership.valid,
                  });
            }
          }
        }
        // Short-lived account/assignment/membership observations never survive the
        // request deadline. The final SQL also checks their actual validity ranges.
        const databaseDeadline = new Date(Date.parse(at) + Math.max(0, deadline - Date.now())).toISOString();
        if (binding !== bind(actor, action, resource) || Date.now() >= deadline) return evidence;
        prepared.set(evidence, {
          binding,
          deadline,
          databaseDeadline,
          principalId,
          valid,
          roles,
          anonymous: actor.kind === 'anonymous',
        });
      } catch {
        // Missing tables, unresolved accounts and failed separately anchored reads deny.
      }
      return evidence;
    },
    authorize: checkPermission,
  };
}

/** Prepare each proposed permission before checkout, then check all of them on
 * every attempt. This deliberately provides no grant mutation or HTTP helper.
 * The command separately checks its registered grant-management action.
 */
export async function checkDelegationBounds(
  access: Access,
  actor: Actor,
  actions: readonly string[],
  resource: Resource,
  context: AccessContext,
): Promise<(client: AccessClient) => Promise<boolean>> {
  try {
    if (actions.length === 0) return async () => false;
    const checks: ((client: AccessClient) => Promise<boolean>)[] = [];
    for (const action of new Set(actions)) checks.push(await accessCheck(access, actor, action, resource, context));
    return async (client) => {
      try {
        for (const check of checks) if (!(await check(client))) return false;
        return true;
      } catch {
        return false;
      }
    };
  } catch {
    return async () => false;
  }
}
