import type { Account } from './account-data.ts';
import { accessCommandAttempt } from './command-admission.ts';
import {
  authoritativeTimeValue,
  hasLiveCommandTransaction,
  registerCommandCallback,
  type AuthoritativeTime,
} from '../command/command.ts';
import {
  accessCheck,
  AuthenticationError,
  type Access,
  type AccessClient,
  type AccessContext,
  type AccessCheck,
  type AccountActor,
  type ActionCatalogue,
  type Actor,
  type Resource,
} from '../request/access.ts';
import { resolveResourceRoles, installResourceRoleCatalogue, type ResourceRoleCatalogue } from './resource-roles.ts';
import { withConnection } from '../database/pool.ts';
import { MEMBERSHIP_LIMIT, type MembershipPrincipal } from './membership-inverse.ts';
import inverseRead from './permission-inverse.sql';
import candidatesRead from './permission-candidates.sql';
import assignmentRead from './permission-assignment.sql';
import membershipRead from './permission-membership.sql';
import timeRead from './permission-time.sql';
import permissionRead from './permission-check.sql';
import governanceReachCandidatesRead from './governance-reach-candidates.sql';
import recordGovernanceReach from './governance-reach-record.sql';
import {
  checkWithGovernanceReach,
  isGlobalReachAction,
  isPlatformResource,
  PLATFORM_RESOURCE,
  usedGovernanceReach,
} from './governance-reach.ts';
import { prepareAnonymousEligibility } from './eligibility.ts';

/** Kernel-owned request evidence, populated by the one authoritative actor point read.
 * Identity and this record must come from verified Auth/Access, never request JSON.
 */
export type PermissionContext = AccessContext & { account?: Account | null };

export type PermissionConfig = {
  actions: ActionCatalogue;
  resourceRoles?: ResourceRoleCatalogue | undefined;
  /** Retrieve the already-read account from the request; do not query again here. */
  accountEvidence: (actor: AccountActor, context: PermissionContext) => Account | null | undefined;
  authenticate?: Access['authenticate'];
  /** Server-owned Realm integration. Read only this Realm/member anchor on the
   * supplied released connection. Return positive and negative proofs for the existing ACL subject roles
   * using native current/next temporal seeks, never an interval-history scan.
   * Proof validity ends at the next authoritative temporal transition.
   * Following is not membership. Missing verifier or required proof denies.
   */
  realmRoleReader?: RealmRoleReader;
  /** Outside a command, bind this instant. Absent uses PostgreSQL clock_timestamp(). */
  clock?: () => Date;
};
export type MembershipRoleProof = { role: 'owner' | 'member'; member: boolean; valid: string };
export type RealmRoleReader = (
  client: AccessClient,
  input: { realmId: string; accountId: string; at: string },
) => Promise<readonly MembershipRoleProof[] | null>;

type RoleEvidence = {
  account_id: string;
  organization_id: string;
  group_kind: MembershipPrincipal['kind'];
  role: 'owner' | 'member';
  member: boolean;
  valid: string;
};

type Prepared = {
  binding: string;
  deadline: number;
  databaseDeadline: string;
  principalId: string | null;
  valid: string;
  roles: RoleEvidence[];
  anonymous: boolean;
  grantRoles: readonly string[];
  scope: boolean;
  admitsAnonymous: boolean;
  capability: Resource['eligibility'];
  verifyFloor: ((client: AccessClient, at: string) => Promise<boolean>) | undefined;
};

// Object identity is the trust boundary: serialized, spread, and caller-created
// objects can never become evidence. The registry retains no request after GC.
const prepared = new WeakMap<object, Prepared>();
/** Internal evidence lifetime for separately anchored command proofs. This is
 * read from the opaque registry, never from caller-supplied authorization JSON.
 */
export function permissionEvidenceDeadline(evidence: unknown): number | undefined {
  return typeof evidence === 'object' && evidence !== null ? prepared.get(evidence)?.deadline : undefined;
}
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${uuid}$`);
const requestedByPattern = new RegExp(`^urn:rezics:request:(${uuid}):(${uuid})$`);
const routeOf = (id: string): number => Number.parseInt(id.slice(24, 28), 16);
/** `at` is the configured instant, or PostgreSQL time when no clock is bound.
 * `databaseAt` is always PostgreSQL `clock_timestamp()`. A caller that stubs only
 * `at` leaves `databaseAt` unset; preparation then fails closed.
 */
async function readPermissionTime(
  client: Parameters<typeof timeRead.run>[0],
  clock?: () => Date,
): Promise<{ at: string; databaseAt: string | undefined } | undefined> {
  const configured = clock?.();
  if (configured && !Number.isFinite(configured.getTime())) throw new TypeError('Invalid command clock');
  const row = await timeRead.run(client, { at: configured?.toISOString() ?? '' });
  if (!row?.at) return undefined;
  return { at: row.at, databaseAt: row.databaseAt };
}
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
  time?: AuthoritativeTime,
  clock?: () => Date,
): Promise<boolean> {
  try {
    const facts = typeof evidence === 'object' && evidence !== null ? prepared.get(evidence) : undefined;
    if (
      !facts ||
      facts.binding !== bind(actor, action, resource) ||
      facts.capability !== (resource.eligibility ?? resource.anonymousEligibility) ||
      (resource.eligibility !== undefined &&
        resource.anonymousEligibility !== undefined &&
        resource.eligibility !== resource.anonymousEligibility) ||
      Date.now() >= facts.deadline
    )
      return false;
    // Obtain one authoritative T on this attempt's own resource client. Domain
    // verification and the permission formula must evaluate exactly this instant.
    const at = time ? authoritativeTimeValue(time) : (await readPermissionTime(client, clock))?.at;
    if (!at) return false;
    const domainEligible = facts.verifyFloor ? await facts.verifyFloor(client, at) : false;
    const floor = facts.admitsAnonymous && domainEligible;
    // Scope caps only the independent authenticated grant branch. Other token
    // scopes neither supply the requested scope nor poison a verified public floor.
    if (!floor && (facts.anonymous || !facts.scope)) return false;
    if (facts.binding !== bind(actor, action, resource) || Date.now() >= facts.deadline) return false;
    const stillValid = () =>
      facts.binding === bind(actor, action, resource) &&
      facts.capability === (resource.eligibility ?? resource.anonymousEligibility) &&
      !(
        resource.eligibility !== undefined &&
        resource.anonymousEligibility !== undefined &&
        resource.eligibility !== resource.anonymousEligibility
      ) &&
      Date.now() < facts.deadline;
    const checkExactResource = async (target: Resource): Promise<boolean | undefined> => {
      if (!stillValid()) return undefined;
      const row = await permissionRead.run(client, {
        route: target.route,
        resource_id: target.id,
        action,
        actor_id: actor.kind === 'account' ? actor.accountId : '',
        principal_id: facts.principalId ?? '',
        anonymous: facts.anonymous,
        floor,
        at,
        roles: facts.roles,
        grant_roles: [...facts.grantRoles],
        evidence_valid: facts.valid,
        deadline: facts.databaseDeadline,
      });
      if (row?.allowed !== true && row?.allowed !== false) return undefined;
      // A query taking longer than its evidence budget cannot produce usable authority.
      return stillValid() ? row.allowed : undefined;
    };
    return await checkWithGovernanceReach(
      evidence,
      action,
      resource,
      () => checkExactResource(resource),
      () => checkExactResource(PLATFORM_RESOURCE),
    );
  } catch {
    return false;
  }
}

/** Thin Access adapter. Auth and the kernel request hook are separate bindings. */
export function createAccess(config: PermissionConfig): Access {
  // Copy metadata so later mutation of the caller's map cannot expand a mounted catalogue.
  const actions = new Map([...config.actions].map(([action, metadata]) => [action, { ...metadata }]));
  const catalogue = resolveResourceRoles(actions, config.resourceRoles);
  const access: Access = {
    replayAuthorization: (action) => actions.get(action)?.replay,
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
            actor.scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope))
          )
            return evidence;
          account = config.accountEvidence(actor, context);
          if (!account || !eligible(account, actor)) return evidence;
        }
        const verifyFloor = await prepareAnonymousEligibility(
          { actor, action, resource: Object.freeze({ ...resource }), deadline },
          context,
        );
        // Every query uses the pool independently before resource checkout. None
        // of these reads holds a connection while another partition is consulted.
        const recorded = await readPermissionTime(context.pool, config.clock);
        if (!recorded?.databaseAt) return evidence;
        // Commands prepare after their executor mints T. Negative membership
        // proofs must start at that same T, not at a later preparation clock.
        const attempt = accessCommandAttempt(context);
        const at = attempt ? authoritativeTimeValue(attempt.time) : recorded.at;
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
            if (principal === actor.accountId) members[0]!.automated ||= assignment.operatorAccountId !== null;
            else members.push({ accountId: principal, automated: assignment.operatorAccountId !== null });
          }
        }
        const grantRoles = [...catalogue.roles].filter(([, values]) => values.includes(action)).map(([role]) => role);
        const roles: RoleEvidence[] = [];
        if (actor.kind === 'account') {
          // The inverse is admission evidence only. Never derive identities from
          // resource ACLs or treat a stale inverse row as a membership role.
          for (const member of members) {
            if (member.automated) continue;
            const rows = await withConnection(context.pool, (client) =>
              inverseRead.run(client, {
                route: routeOf(member.accountId),
                account_id: member.accountId,
              }),
            );
            if (!rows.length || rows.some((r) => r.complete !== true)) return evidence;
            const inverse: MembershipPrincipal[] = [];
            for (const row of rows) {
              if (row.kind === null && row.id === null) continue;
              if (
                (row.kind !== 'organization' && row.kind !== 'realm') ||
                !row.id ||
                row.id === member.accountId ||
                !uuidPattern.test(row.id)
              )
                return evidence;
              inverse.push({ kind: row.kind, id: row.id });
            }
            if (inverse.length > MEMBERSHIP_LIMIT || new Set(inverse.map((g) => g.id)).size !== inverse.length)
              return evidence;
            for (const group of inverse)
              for (const role of ['owner', 'member'] as const)
                roles.push({
                  account_id: member.accountId,
                  organization_id: group.id,
                  group_kind: group.kind,
                  role,
                  member: false,
                  valid: 'empty',
                });
          }
          const candidates =
            isGlobalReachAction(action) && !isPlatformResource(resource)
              ? await governanceReachCandidatesRead.run(context.pool, {
                  route: resource.route,
                  resource_id: resource.id,
                  action,
                  grant_roles: grantRoles,
                  actor_id: actor.accountId,
                  principal_id: principalId ?? '',
                  roles,
                  at,
                  include_global: true,
                })
              : await candidatesRead.run(context.pool, {
                  route: resource.route,
                  resource_id: resource.id,
                  action,
                  grant_roles: grantRoles,
                  actor_id: actor.accountId,
                  principal_id: principalId ?? '',
                  roles,
                  at,
                });
          // Only hits from the single bounded probe cause an anchored role read.
          const hits = new Set(candidates.map((row) => `${row.accountId}/${row.organizationId}`));
          const groups = new Map<string, RoleEvidence[]>();
          for (const row of roles) {
            const key = `${row.account_id}/${row.organization_id}`;
            const entries = groups.get(key) ?? [];
            entries.push(row);
            groups.set(key, entries);
          }
          const matched = [...groups].filter(([key]) => hits.has(key)).map(([, entries]) => entries);
          // Independent anchor reads borrow/release their own client. Bounded
          // batches never acquire a second client inside an anchored callback;
          // all settle before any resource checkout, including failure paths.
          for (let start = 0; start < matched.length; start += 4) {
            const results = await Promise.allSettled(
              matched.slice(start, start + 4).map(async (entries) => {
                const group = entries[0]!;
                const proofs = await withConnection(context.pool, async (client) => {
                  if (group.group_kind === 'realm')
                    return (
                      config.realmRoleReader?.(client, {
                        realmId: group.organization_id,
                        accountId: group.account_id,
                        at,
                      }) ?? null
                    );
                  const rows = await membershipRead.run(client, {
                    route: routeOf(group.organization_id),
                    organization_id: group.organization_id,
                    member_id: group.account_id,
                    at,
                  });
                  if (
                    rows.length !== 2 ||
                    rows.some((r) => r.kind !== 'organization' || r.state !== 'active' || r.fenced !== false)
                  )
                    return null;
                  return rows;
                });
                if (
                  !proofs ||
                  proofs.length !== 2 ||
                  new Set(proofs.map((r) => r.role)).size !== 2 ||
                  proofs.some((r) => !['owner', 'member'].includes(r.role) || typeof r.member !== 'boolean' || !r.valid)
                )
                  return false;
                for (const proof of proofs) {
                  if (!proof.valid) return false;
                  const row = entries.find((r) => r.role === proof.role)!;
                  row.member = proof.member;
                  row.valid = proof.valid;
                }
                return true;
              }),
            );
            if (results.some((result) => result.status === 'rejected' || !result.value)) return evidence;
          }
        }
        // Short-lived account/assignment/membership observations never survive the
        // request deadline. The final SQL also checks their actual validity ranges
        // at T. The evidence deadline guards elapsed database time: databaseAt plus
        // the remaining budget, compared only with observed_at. The wall-clock
        // check above stays local.
        const origin = Date.parse(recorded.databaseAt);
        if (!Number.isFinite(origin)) return evidence;
        const databaseDeadline = new Date(origin + Math.max(0, deadline - Date.now())).toISOString();
        if (binding !== bind(actor, action, resource) || Date.now() >= deadline) return evidence;
        prepared.set(evidence, {
          binding,
          deadline,
          databaseDeadline,
          principalId,
          valid,
          roles,
          anonymous: actor.kind === 'anonymous',
          grantRoles,
          scope: actor.kind === 'account' && actor.scopes.includes(action),
          admitsAnonymous: metadata.anonymous,
          capability: resource.eligibility ?? resource.anonymousEligibility,
          verifyFloor,
        });
      } catch {
        // Missing tables, unresolved accounts and failed separately anchored reads deny.
      }
      return evidence;
    },
    async authorize(client, actor, action, resource, evidence, time) {
      const allowed = await checkPermission(client, actor, action, resource, evidence, time, config.clock);
      if (allowed && actor.kind === 'account' && usedGovernanceReach(evidence) && hasLiveCommandTransaction(client)) {
        const target = Object.freeze({ route: resource.route, id: resource.id });
        registerCommandCallback(client, (transactionId) =>
          recordGovernanceReach.run(client, {
            route: target.route,
            transaction_id: transactionId,
            action,
            resource_id: target.id,
            actor_account_id: actor.accountId,
          }),
        );
      }
      return allowed;
    },
  };
  installResourceRoleCatalogue(access, catalogue);
  return access;
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
): Promise<AccessCheck> {
  try {
    if (actions.length === 0) return async () => false;
    const checks: AccessCheck[] = [];
    for (const action of new Set(actions)) checks.push(await accessCheck(access, actor, action, resource, context));
    return async (client, time) => {
      try {
        for (const check of checks) if (!(await check(client, time))) return false;
        return true;
      } catch {
        return false;
      }
    };
  } catch {
    return async () => false;
  }
}
