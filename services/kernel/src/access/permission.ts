import {
  accessNativeWork,
  accessNativeDeclaration,
  addAccessWork,
  accessCheckout,
  accessOwnerWork,
  AccessWorkUnavailableError,
  type AccessWorkAccounting,
  type AccessWorkProducer,
} from './work.ts';
import {
  copyContentEditionBenefit,
  contentEditionBenefitBinding,
  matchesContentEditionBuyerFact,
  type ContentEditionBenefit,
  type ContentEditionBuyerFact,
  type ContentEditionBuyerFactReader,
} from './authenticated-benefit.ts';
import { ACCOUNT_ROLE_BITS as HISTORY_ROLE } from '../history/contracts.ts';
import { accessEvidence, throwEvidenceFailure } from './evidence.ts';
import { ACCESS_EVIDENCE_TTL_MS, accessEvidenceDeadline } from './evidence-deadline.ts';
import { AccessUnavailableError, requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';
import { readNativeAccessTime } from './authenticate.ts';
import { readNativeAccountStates, readNativePermissionAccount, type PermissionAccount } from './account-authority.ts';
import { readAccount, type Account } from './account-data.ts';
import { readAccountActionStates, accountProfileAuthorityAnchor } from './account-viewer-actions.ts';
import { installAccountStandingCheck } from './account-standing.ts';
import { accessCommandAttempt } from './command-admission.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  hasLiveCommandTransaction,
  type AuthoritativeTime,
} from '../command/command.ts';
import {
  accessCheck,
  installPreparedAccessCheckWork,
  type PreparedAccessCheckInvocation,
  type PreparedAccessCheckWork,
  validReadDecisionActions,
  resourcePage,
  type ResourcePage,
  type AccessRealmRoleReader,
  type PrepareReadDecisionsInput,
  type ReadDecisions,
  type AccountAuthority,
  type AccountAuthorityDecision,
  AuthenticationError,
  type Access,
  type AccessClient,
  type AccessDecision,
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
import { routeOf as readRoute } from '../route/route.ts';
import { deadlineClient, within } from './authenticate.ts';
import inverseRead from './permission-inverse.sql';
import candidatesRead from './permission-candidates.sql';
import assignmentRead from './permission-assignment.sql';
import membershipRead from './permission-membership.sql';
import timeRead from './permission-time.sql';
import permissionRead from './permission-check.sql';
import governanceReachCandidatesRead from './governance-reach-candidates.sql';
import {
  setGovernanceReach,
  governanceReachUse,
  isGlobalReachAction,
  isPlatformResource,
  PLATFORM_RESOURCE,
  recordGovernanceReachUse,
} from './governance-reach.ts';
import { prepareAnonymousEligibility, type PreparedEligibilityVerify } from './eligibility.ts';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createKindAudienceOriginal, type KindOriginalProducer } from './kind-audience-original.ts';
import { kindOriginalFormulaPlan } from './kind-audience-formula.ts';
import { readExposure, GLOBAL_CONTEXT } from './gates/catalogue.ts';
import {
  compileNativePolicyCatalogue,
  decideNativePermission,
  type NativePermissionProjection,
} from './policy-core.ts';
import type { PolicyCatalogue } from '@rezics/access';
// Only the Kind original invocation needs a Source-eight-axis declaration for
// foreign callbacks. Ordinary preparation retains its installed owner protocol.
const kindOriginalInvocation = new AsyncLocalStorage<boolean>();

/** Kernel-owned request evidence, populated by the one authoritative actor point read.
 * Identity and this record must come from verified Auth/Access, never request JSON.
 */
export type PermissionContext = AccessContext & { account?: Account | null };

export type PermissionConfig = {
  /** Private installed-authenticator association for Kind originals only. */
  kindOriginal?: KindOriginalProducer;
  actions: ActionCatalogue;
  resourceRoles?: ResourceRoleCatalogue | undefined;
  /** Retrieve the already-read account from the request; do not query again here. */
  accountEvidence: (actor: AccountActor, context: PermissionContext) => PermissionAccount | null | undefined;
  authenticate?: Access['authenticate'];
  /** Private, per-factory standing evidence shared with the main Access adapter. */
  standingAccounts?: WeakMap<AccountActor, PermissionAccount>;
  /** Server-owned Realm integration. Read only this Realm/member anchor on the
   * supplied released connection. Return positive and negative proofs for the existing ACL subject roles
   * using native current/next temporal seeks, never an interval-history scan.
   * Proof validity ends at the next authoritative temporal transition.
   * Following is not membership. Missing verifier or required proof denies.
   */
  realmRoleReader?: RealmRoleReader;
  contentEditionBuyerFactReader?: ContentEditionBuyerFactReader;
  contentEditionBuyerFactWork?: AccessWorkProducer<
    Parameters<ContentEditionBuyerFactReader>[0],
    Awaited<ReturnType<ContentEditionBuyerFactReader>>
  >;
  /** Outside a command, bind this instant. Absent uses PostgreSQL clock_timestamp(). */
  clock?: () => Date;
};
export type MembershipRoleProof = { role: 'owner' | 'member'; member: boolean; valid: string };
export type RealmRoleReader = AccessRealmRoleReader;

type RoleEvidence = {
  account_id: string;
  organization_id: string;
  group_kind: MembershipPrincipal['kind'];
  role: 'owner' | 'member';
  member: boolean;
  valid: string;
};

type BuyerEvidence = Readonly<{
  benefit: ContentEditionBenefit;
  time: AuthoritativeTime;
  deadline: number;
  buyers: ReadonlyMap<string, ContentEditionBuyerFact>;
}>;

function validBuyerEvidence(proof: BuyerEvidence, time: AuthoritativeTime | undefined): boolean {
  if (proof.time !== time) return false;
  authoritativeTimeValue(proof.time);
  requireAccessDeadline(proof.deadline);
  return [...proof.buyers].every(([buyerAccountId, fact]) =>
    matchesContentEditionBuyerFact(fact, {
      benefit: proof.benefit,
      buyerAccountId,
      time: proof.time,
      deadline: proof.deadline,
    }),
  );
}

type Prepared = {
  policyCatalogue: PolicyCatalogue;
  work?: AccessWorkAccounting;
  time?: AuthoritativeTime;
  buyerEvidence?: BuyerEvidence;
  historyAccounts: readonly import('../history/locator.ts').AccountReference[];
  ownAccount: boolean;
  binding: string;
  deadline: number;
  databaseDeadline: string;
  principalId: string | null;
  assignmentRoute: number | null;
  assignmentRequestId: string | null;
  roles: RoleEvidence[];
  anonymous: boolean;
  grantRoles: readonly string[];
  scope: boolean;
  admitsAnonymous: boolean;
  capability: Resource['eligibility'];
  verifyFloor: PreparedEligibilityVerify | undefined;
};

// Object identity is the trust boundary: serialized, spread, and caller-created
// objects can never become evidence. The registry retains no request after GC.
const prepared = new WeakMap<object, Prepared>();
/** Opaque native batch evidence also serves admission's gate checks. Callers
 * cannot manufacture this handle or replace the borrowed scope operand. */
const readEvidence = new WeakMap<
  ReadDecisions,
  {
    time: AuthoritativeTime;
    gate(client: AccessClient, action: string, clientAction: string, resource: Resource): Promise<boolean>;
  }
>();
export function readDecisionTime(handle: ReadDecisions): AuthoritativeTime | undefined {
  return readEvidence.get(handle)?.time;
}
export function authorizePreparedReadGate(
  handle: ReadDecisions,
  client: AccessClient,
  action: string,
  clientAction: string,
  resource: Resource,
): Promise<boolean> {
  return readEvidence.get(handle)?.gate(client, action, clientAction, resource) ?? Promise.resolve(false);
}

/** Internal evidence lifetime for separately anchored command proofs. This is
 * read from the opaque registry, never from caller-supplied authorization JSON.
 */
export function permissionEvidenceDeadline(evidence: unknown): number | undefined {
  return typeof evidence === 'object' && evidence !== null ? prepared.get(evidence)?.deadline : undefined;
}

/** Exact native identity projection; reconstructed Actors and JSON have no entry. */
export function permissionHistoryAccounts(
  evidence: unknown,
  actor: Actor,
  action: string,
  resource: Resource,
  page?: ResourcePage,
) {
  const proof = typeof evidence === 'object' && evidence !== null ? prepared.get(evidence) : undefined;
  if (!proof || proof.binding !== bind(actor, action, resource, page) || Date.now() >= proof.deadline) return undefined;
  return structuredClone(proof.historyAccounts);
}
// NUL is outside OAuth VSCHAR and cannot be persisted in PostgreSQL text.
const STANDING_CLIENT_ID = '\u0000account-standing';
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
  work?: AccessWorkAccounting,
): Promise<{ at: string; databaseAt: string | undefined; observedAt: number } | undefined> {
  const configured = clock?.();
  if (configured && !Number.isFinite(configured.getTime())) throw new TypeError('Invalid command clock');
  const observedAt = Date.now();
  const input = { at: configured?.toISOString() ?? '' };
  const row = await accessNativeWork(work, 'time', input, {}, () => timeRead.run(client, input));
  if (!row?.at) return undefined;
  return { at: row.at, databaseAt: row.databaseAt, observedAt };
}
const bind = (actor: Actor, action: string, resource: Resource, page?: ResourcePage): string =>
  JSON.stringify([
    actor.kind,
    actor.kind === 'account'
      ? [actor.accountId, actor.clientId, actor.scopes, actor.requestedBy, actor.authnEpoch]
      : null,
    action,
    resource.route,
    page ? [page.resourceType, page.ids] : resource.id,
    resource.authenticatedBenefit === undefined ? null : contentEditionBenefitBinding(resource.authenticatedBenefit),
  ]);

function eligible(account: PermissionAccount, actor: AccountActor): boolean {
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

function preparedFormula(
  facts: Prepared,
  actor: Actor,
  action: string,
  resource: Resource,
  at: string,
  floor: boolean,
  page?: ResourcePage,
  includeExplicit = false,
) {
  const ids = page?.ids ?? [resource.id];
  const input = {
    route: resource.route,
    resource_ids: [...ids],
    include_explicit: includeExplicit && !facts.anonymous && facts.scope,
    policy_core: action === 'collection:read',
    include_global: isGlobalReachAction(action),
    action,
    own_account: facts.ownAccount,
    authenticated_resource_id: facts.buyerEvidence?.benefit.resource.id ?? null,
    authenticated_buyer_ids: facts.buyerEvidence ? [...facts.buyerEvidence.buyers.keys()] : [],
    actor_id: actor.kind === 'account' ? actor.accountId : '',
    principal_id: facts.principalId ?? '',
    assignment_route: facts.assignmentRoute,
    assignment_request_id: facts.assignmentRequestId,
    anonymous: facts.anonymous,
    floor,
    at,
    roles: facts.roles,
    grant_roles: [...facts.grantRoles],
    deadline: facts.databaseDeadline,
  };
  const shape = {
    targets: ids.length,
    roles: facts.roles.length,
    members: actor.kind === 'account' ? (facts.principalId ? 2 : 1) : 0,
    grantRoles: facts.grantRoles.length,
    explicit: input.include_explicit,
    global: input.include_global,
    assignment: facts.assignmentRequestId !== null,
  };
  return { input, shape };
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
  return (await checkPreparedPermission(client, actor, action, resource, evidence, time, clock)).allowed;
}

async function checkPreparedPermission(
  client: AccessClient,
  actor: Actor,
  action: string,
  resource: Resource,
  evidence?: unknown,
  time?: AuthoritativeTime,
  clock?: () => Date,
  page?: ResourcePage,
  includeExplicit = false,
): Promise<AccessDecision & { decisions?: Readonly<Record<string, boolean>> }> {
  setGovernanceReach(evidence, []);
  const facts = typeof evidence === 'object' && evidence !== null ? prepared.get(evidence) : undefined;
  try {
    if (facts) requireAccessDeadline(facts.deadline);
    if (
      !facts ||
      (facts.work !== undefined && facts.time !== time) ||
      facts.binding !== bind(actor, action, resource, page) ||
      facts.capability !== (resource.eligibility ?? resource.anonymousEligibility) ||
      (resource.eligibility !== undefined &&
        resource.anonymousEligibility !== undefined &&
        resource.eligibility !== resource.anonymousEligibility)
    )
      return { allowed: false, explicit: false };
    // Obtain one authoritative T on this attempt's own resource client. Domain
    // verification and the permission formula must evaluate exactly this instant.
    const at = time ? authoritativeTimeValue(time) : (await readPermissionTime(client, clock, facts.work))?.at;
    requireAccessDeadline(facts.deadline);
    if (!at || (facts.buyerEvidence && !validBuyerEvidence(facts.buyerEvidence, time)))
      return { allowed: false, explicit: false };
    const domainEligible = facts.verifyFloor ? await facts.verifyFloor(client, at, time, facts.work) : false;
    requireAccessDeadline(facts.deadline);
    const floor = facts.admitsAnonymous && domainEligible;
    // Scope caps only the independent authenticated grant branch. Other token
    // scopes neither supply the requested scope nor poison a verified public floor.
    if (!floor && (facts.anonymous || !facts.scope) && action !== 'collection:read')
      return { allowed: false, explicit: false };
    requireAccessDeadline(facts.deadline);
    if (facts.binding !== bind(actor, action, resource, page)) return { allowed: false, explicit: false };
    const stillValid = () => {
      requireAccessDeadline(facts.deadline);
      return (
        (!facts.buyerEvidence || validBuyerEvidence(facts.buyerEvidence, time)) &&
        facts.binding === bind(actor, action, resource, page) &&
        facts.capability === (resource.eligibility ?? resource.anonymousEligibility) &&
        !(
          resource.eligibility !== undefined &&
          resource.anonymousEligibility !== undefined &&
          resource.eligibility !== resource.anonymousEligibility
        )
      );
    };
    if (!stillValid()) return { allowed: false, explicit: false };
    const ids = page?.ids ?? [resource.id];
    const formula = preparedFormula(facts, actor, action, resource, at, floor, page, includeExplicit);
    const rows = await accessNativeWork(facts.work, 'formula', formula.input, formula.shape, () =>
      permissionRead.run(client, formula.input),
    );
    if (
      !stillValid() ||
      rows.length !== ids.length ||
      new Set(rows.map((row) => row.resourceId)).size !== ids.length ||
      rows.some(
        (row) =>
          typeof row.resourceId !== 'string' ||
          !ids.includes(row.resourceId) ||
          (action === 'collection:read' ? typeof row.live !== 'boolean' : typeof row.allowed !== 'boolean'),
      )
    )
      return { allowed: false, explicit: false };
    if (action === 'collection:read') {
      const resourceType = page?.resourceType ?? facts.policyCatalogue.actionByName[action]?.resourceTypes[0] ?? '';
      const hasPrincipal = facts.principalId !== null;
      const canEvaluateExplicit = includeExplicit && !facts.anonymous && facts.scope;
      const project = (row: (typeof rows)[number]) => row as unknown as NativePermissionProjection;
      const ordinary = rows.map((row) =>
        decideNativePermission(
          facts.policyCatalogue,
          {
            action,
            resourceType,
            anonymous: facts.anonymous,
            hasPrincipal,
            authenticatedBenefit: facts.buyerEvidence !== undefined,
            scope: facts.scope,
            floor,
            mode: 'ordinary',
          },
          project(row),
        ),
      );
      const explicit = canEvaluateExplicit
        ? rows.map((row) =>
            decideNativePermission(
              facts.policyCatalogue,
              {
                action,
                resourceType,
                anonymous: facts.anonymous,
                hasPrincipal,
                authenticatedBenefit: facts.buyerEvidence !== undefined,
                scope: facts.scope,
                floor: false,
                mode: 'explicit',
              },
              project(row),
            ),
          )
        : [];
      const decisions = Object.freeze(
        Object.fromEntries(rows.map((row, index) => [row.resourceId!, ordinary[index]?.decision === 'allow'])),
      );
      return {
        allowed: ordinary.every((decision) => decision.decision === 'allow'),
        explicit: canEvaluateExplicit && explicit.every((decision) => decision.decision === 'allow'),
        decisions,
      };
    }
    const allowed = rows.every((row) => row.allowed === true);
    if (allowed)
      setGovernanceReach(
        evidence,
        rows.flatMap((row) =>
          row.governanceReach && typeof row.resourceId === 'string'
            ? [{ route: resource.route, id: row.resourceId }]
            : [],
        ),
      );
    return {
      allowed,
      explicit: includeExplicit && rows.every((row) => row.explicit === true),
      decisions: Object.freeze(Object.fromEntries(rows.map((row) => [row.resourceId!, row.allowed === true]))),
    };
  } catch (error) {
    facts?.work?.fail(error);
    throwAccessUnavailable(error, facts?.deadline);
    throwEvidenceFailure(error);
    return { allowed: false, explicit: false };
  }
}

/** Only current native preparation on this accounting/time can declare final work. */
function preparedCheckWork(
  actor: Actor,
  action: string,
  resource: Resource,
  evidence: unknown,
  dispatch: (input: PreparedAccessCheckInvocation) => Promise<boolean>,
): PreparedAccessCheckWork | undefined {
  const facts = typeof evidence === 'object' && evidence !== null ? prepared.get(evidence) : undefined;
  if (!facts?.work || !facts.time) return undefined;
  const receipts = new WeakMap<
    PreparedAccessCheckInvocation,
    {
      value: boolean;
      usage: import('./work.ts').AccessWork;
      client: AccessClient;
      time: AuthoritativeTime;
      work: AccessWorkAccounting;
    }
  >();
  const invoked = new WeakSet<PreparedAccessCheckInvocation>();
  const bound = (input: PreparedAccessCheckInvocation) => {
    if (
      input.work !== facts.work ||
      input.time !== facts.time ||
      Date.now() >= facts.deadline ||
      facts.binding !== bind(actor, action, resource) ||
      facts.capability !== (resource.eligibility ?? resource.anonymousEligibility) ||
      (resource.eligibility !== undefined &&
        resource.anonymousEligibility !== undefined &&
        resource.eligibility !== resource.anonymousEligibility)
    )
      return undefined;
    let at: string;
    try {
      at = authoritativeTimeValue(input.time);
    } catch {
      return undefined;
    }
    const owner = facts.verifyFloor ? facts.verifyFloor.bound?.(input) : undefined;
    if (facts.verifyFloor && !owner) return undefined;
    // false is the larger serialized boolean; the mounted native plan is identical
    // for either eligibility outcome. Undispatched branches settle at zero.
    const formula = preparedFormula(facts, actor, action, resource, at, false);
    return addAccessWork(
      accessNativeDeclaration('formula', formula.input, formula.shape).bound,
      ...(owner ? [owner] : []),
    );
  };
  return {
    bound,
    async run(input) {
      if (invoked.has(input)) return input.work.unavailable('Access prepared invocation already dispatched');
      invoked.add(input);
      const { client, time, work } = input;
      const result = await work.invocation(
        'Access prepared check',
        bound(input),
        async () => {
          const value = await dispatch(input);
          if (input.client !== client || input.time !== time || input.work !== work)
            return work.unavailable('Access prepared invocation changed during dispatch');
          authoritativeTimeValue(time);
          return value;
        },
        facts.deadline,
      );
      receipts.set(input, { ...result, client, time, work });
      return result.value;
    },
    actual(input, value) {
      const receipt = receipts.get(input);
      receipts.delete(input);
      if (
        !receipt ||
        receipt.value !== value ||
        receipt.client !== input.client ||
        receipt.time !== input.time ||
        receipt.work !== input.work ||
        Date.now() >= facts.deadline
      )
        return undefined;
      try {
        authoritativeTimeValue(input.time);
      } catch {
        return undefined;
      }
      return receipt.usage;
    },
  };
}

/** Thin Access adapter. Auth and the kernel request hook are separate bindings. */
export function createAccess(config: PermissionConfig): Access {
  // Copy metadata so later mutation of the caller's map cannot expand a mounted catalogue.
  const actions = new Map([...config.actions].map(([action, metadata]) => [action, { ...metadata }]));
  const catalogue = resolveResourceRoles(actions, config.resourceRoles);
  const policyCatalogue = compileNativePolicyCatalogue(actions, catalogue);
  const standingAccounts = config.standingAccounts ?? new WeakMap<AccountActor, PermissionAccount>();
  const standingScopes = Object.freeze([...actions.keys()]);
  async function preparePermission(
    actor: Actor,
    action: string,
    resource: Resource,
    context: AccessContext,
    page?: ResourcePage,
    perId = false,
  ) {
    const evidence = Object.freeze({});
    const deadline = accessEvidenceDeadline(context.deadline, ACCESS_EVIDENCE_TTL_MS);
    try {
      requireAccessDeadline(deadline);
      const metadata = actions.get(action);
      if (
        !metadata ||
        !Number.isInteger(resource.route) ||
        resource.route < 0 ||
        resource.route > 65535 ||
        !uuidPattern.test(resource.id) ||
        routeOf(resource.id) !== resource.route ||
        !Number.isFinite(context.deadline)
      )
        return evidence;
      if (metadata.authority === 'own-account' && (actor.kind !== 'account' || resource.id !== actor.accountId || page))
        return evidence;
      const attempt = accessCommandAttempt(context);
      if (attempt && context.time !== undefined && context.time !== attempt.time) return evidence;
      const time = attempt?.time ?? context.time;
      if (time) authoritativeTimeValue(time);
      if (context.work && !time)
        context.work.unavailable('Access metered preparation requires a live native AuthoritativeTime');
      const benefit =
        resource.authenticatedBenefit === undefined
          ? undefined
          : copyContentEditionBenefit(resource.authenticatedBenefit);
      if (
        benefit &&
        (page ||
          actor.kind !== 'account' ||
          action !== benefit.action ||
          resource.route !== benefit.resource.route ||
          resource.id !== benefit.resource.id)
      )
        return evidence;
      // The native read caller owns mintReadTime/releaseOperationalTime. Access
      // does not introduce another clock or a hidden time lifetime for benefits.
      if (benefit && !time) return evidence;
      const ownAccount = metadata.authority === 'own-account';
      const binding = bind(actor, action, resource, page);
      let account: PermissionAccount | null | undefined;
      if (actor.kind === 'anonymous') {
        if (!metadata.anonymous) return evidence;
      } else {
        if (
          !uuidPattern.test(actor.accountId) ||
          !actor.clientId ||
          actor.scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope))
        )
          return evidence;
        account = standingAccounts.get(actor) ?? config.accountEvidence(actor, context);
        if (!account || !eligible(account, actor)) return evidence;
      }
      const verifyFloor = await prepareAnonymousEligibility(
        { actor, action, resource: Object.freeze({ ...resource }), deadline },
        { ...context, ...(time ? { time } : {}) },
      );
      // Every query uses the pool independently before resource checkout. None
      // of these reads holds a connection while another partition is consulted.
      const recorded = await readPermissionTime(context.pool, config.clock, context.work);
      if (!recorded?.databaseAt) return evidence;
      // Commands prepare after their executor mints T. Negative membership
      // proofs must start at that same T, not at a later preparation clock.
      const at = time ? authoritativeTimeValue(time) : recorded.at;
      let principalId: string | null = null;
      let assignmentRoute: number | null = null;
      let assignmentRequestId: string | null = null;
      const members: { accountId: string; automated: boolean }[] = [];
      if (actor.kind === 'account' && account) {
        members.push({ accountId: actor.accountId, automated: account.operatorAccountId !== null });
        if (actor.requestedBy !== null) {
          const request = requestedByPattern.exec(actor.requestedBy);
          if (!request) return evidence;
          const principal = request[1]!;
          assignmentRoute = routeOf(principal);
          assignmentRequestId = request[2]!;
          const assignmentInput = {
            route: assignmentRoute,
            principal_id: principal,
            request_id: assignmentRequestId,
            actor_id: actor.accountId,
            at,
          };
          const assignment = await accessNativeWork(context.work, 'assignment', assignmentInput, {}, () =>
            assignmentRead.run(context.pool, assignmentInput),
          );
          if (
            !assignment ||
            assignment.kind !== 'actor' ||
            assignment.state !== 'active' ||
            assignment.fenced !== false
          )
            return evidence;
          principalId = principal;
          if (principal === actor.accountId) members[0]!.automated ||= assignment.operatorAccountId !== null;
          else members.push({ accountId: principal, automated: assignment.operatorAccountId !== null });
        }
      }
      let buyerEvidence: BuyerEvidence | undefined;
      if (benefit && time) {
        const reader = config.contentEditionBuyerFactReader;
        if (!reader) throw new AccessUnavailableError('overloaded');
        const buyers = new Map<string, ContentEditionBuyerFact>();
        // Actual resolved identities only, sequential and bounded to actor plus
        // one distinct current principal. Null proves absence for that identity.
        for (const { accountId: buyerAccountId } of members) {
          const input = Object.freeze({ benefit, buyerAccountId, time, deadline: context.deadline });
          let fact: ContentEditionBuyerFact | null;
          try {
            fact = await within(context.deadline, () =>
              accessOwnerWork(
                context.work,
                'Commerce ContentEditionBuyerFactReader',
                config.contentEditionBuyerFactWork,
                input,
                () => reader(input),
              ),
            );
          } catch (error) {
            throwAccessUnavailable(error, context.deadline);
            throw new AccessUnavailableError('overloaded');
          }
          requireAccessDeadline(deadline);
          if (fact !== null) {
            if (!matchesContentEditionBuyerFact(fact, input)) return evidence;
            buyers.set(buyerAccountId, fact);
          }
        }
        buyerEvidence = Object.freeze({ benefit, time, deadline: context.deadline, buyers });
      }
      const grantRoles = [...catalogue.roles].filter(([, values]) => values.includes(action)).map(([role]) => role);
      const roles: RoleEvidence[] = [];
      if (actor.kind === 'account') {
        // The inverse is admission evidence only. Never derive identities from
        // resource ACLs or treat a stale inverse row as a membership role.
        for (const member of members) {
          if (member.automated) continue;
          const inverseInput = { route: routeOf(member.accountId), account_id: member.accountId };
          const rows = await accessCheckout(context.work, () =>
            withConnection(context.pool, (client) =>
              accessNativeWork(context.work, 'inverse', inverseInput, { members: 1, groups: MEMBERSHIP_LIMIT }, () =>
                inverseRead.run(client, inverseInput),
              ),
            ),
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
        const candidateInput = {
          route: resource.route,
          resource_ids: [...(page?.ids ?? [resource.id])],
          action,
          grant_roles: grantRoles,
          actor_id: actor.accountId,
          principal_id: principalId ?? '',
          roles,
          at,
        };
        // Preparation keeps the page and Global Context reads separately anchored.
        // The final formula still evaluates both at T in its sole statement.
        const candidates =
          isGlobalReachAction(action) && !isPlatformResource(resource)
            ? (
                await Promise.all([
                  accessNativeWork(
                    context.work,
                    'candidates',
                    candidateInput,
                    {
                      targets: candidateInput.resource_ids.length,
                      roles: roles.length,
                      members: principalId ? 2 : 1,
                      grantRoles: grantRoles.length,
                    },
                    () => governanceReachCandidatesRead.run(context.pool, candidateInput),
                  ),
                  (() => {
                    const globalInput = {
                      ...candidateInput,
                      route: PLATFORM_RESOURCE.route,
                      resource_ids: [PLATFORM_RESOURCE.id],
                    };
                    return accessNativeWork(
                      context.work,
                      'candidates',
                      globalInput,
                      {
                        targets: 1,
                        roles: roles.length,
                        members: principalId ? 2 : 1,
                        grantRoles: grantRoles.length,
                      },
                      () => governanceReachCandidatesRead.run(context.pool, globalInput),
                    );
                  })(),
                ])
              ).flat()
            : await accessNativeWork(
                context.work,
                'candidates',
                candidateInput,
                {
                  targets: candidateInput.resource_ids.length,
                  roles: roles.length,
                  members: principalId ? 2 : 1,
                  grantRoles: grantRoles.length,
                },
                () => candidatesRead.run(context.pool, candidateInput),
              );
        // Only hits from these bounded probes cause an anchored role read.
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
              const proofs = await accessCheckout(context.work, () =>
                withConnection(context.pool, async (client) => {
                  if (group.group_kind === 'realm')
                    return accessEvidence(
                      () => {
                        const input = { realmId: group.organization_id, accountId: group.account_id, at };
                        return accessOwnerWork(
                          context.work,
                          'Content AccessRealmRoleReader',
                          config.realmRoleReader?.work,
                          input,
                          () => config.realmRoleReader?.(client, input) ?? Promise.resolve(null),
                        );
                      },
                      false,
                      deadline,
                    );
                  const membershipInput = {
                    route: routeOf(group.organization_id),
                    organization_id: group.organization_id,
                    member_id: group.account_id,
                    at,
                  };
                  const rows = await accessNativeWork(context.work, 'membership', membershipInput, { groups: 1 }, () =>
                    membershipRead.run(client, membershipInput),
                  );
                  if (rows.length !== 2 || rows.some((r) => r.kind !== 'organization')) return null;
                  return rows;
                }),
              );
              if (
                !proofs ||
                proofs.length !== 2 ||
                new Set(proofs.map((r) => r.role)).size !== 2 ||
                proofs.some((r) => !['owner', 'member'].includes(r.role) || typeof r.member !== 'boolean' || !r.valid)
              )
                return false;
              for (const proof of proofs) {
                if (!proof.valid || typeof proof.member !== 'boolean') return false;
                const row = entries.find((r) => r.role === proof.role)!;
                row.member = proof.member;
                row.valid = proof.valid;
              }
              return true;
            }),
          );
          for (const result of results)
            if (result.status === 'rejected') {
              throwAccessUnavailable(result.reason, deadline);
              throwEvidenceFailure(result.reason);
            }
          // Per-id pages retain empty proof ranges so SQL denies only ids
          // that need an unresolved role. Ordinary page admission stays fail-closed.
          if (!perId && results.some((result) => result.status === 'rejected' || !result.value)) return evidence;
        }
      }
      // Short-lived account/assignment/membership observations never survive the
      // request deadline. The final SQL also checks their actual validity ranges
      // at T. The evidence deadline guards elapsed database time: databaseAt plus
      // the budget left when databaseAt was read, compared only with observed_at.
      // The wall-clock check above stays local.
      const origin = Date.parse(recorded.databaseAt);
      if (!Number.isFinite(origin)) return evidence;
      const databaseDeadline = new Date(origin + Math.max(0, deadline - recorded.observedAt)).toISOString();
      requireAccessDeadline(deadline);
      if (binding !== bind(actor, action, resource, page)) return evidence;
      prepared.set(evidence, {
        policyCatalogue,
        ...(context.work ? { work: context.work } : {}),
        ...(time ? { time } : {}),
        ...(buyerEvidence ? { buyerEvidence } : {}),
        historyAccounts:
          actor.kind === 'anonymous'
            ? []
            : [
                {
                  accountRoute: routeOf(actor.accountId)!,
                  accountId: actor.accountId,
                  roles:
                    HISTORY_ROLE.actor |
                    (principalId === null || principalId === actor.accountId
                      ? HISTORY_ROLE.principal
                      : HISTORY_ROLE.delegate) |
                    (account?.operatorAccountId === null ? HISTORY_ROLE['acting-human'] : 0),
                },
                ...(principalId !== null && principalId !== actor.accountId
                  ? [{ accountRoute: routeOf(principalId)!, accountId: principalId, roles: HISTORY_ROLE.principal }]
                  : []),
              ],
        ownAccount,
        binding,
        deadline,
        databaseDeadline,
        principalId,
        assignmentRoute,
        assignmentRequestId,
        roles,
        anonymous: actor.kind === 'anonymous',
        grantRoles,
        scope: actor.kind === 'account' && actor.scopes.includes(action),
        admitsAnonymous: metadata.anonymous,
        capability: resource.eligibility ?? resource.anonymousEligibility,
        verifyFloor,
      });
    } catch (error) {
      context.work?.fail(error);
      throwAccessUnavailable(error, deadline);
      throwEvidenceFailure(error);
      // Missing tables, unresolved accounts and other unclassified evidence failures deny.
    }
    return evidence;
  }
  async function prepareReadDecisions(input: PrepareReadDecisionsInput): Promise<ReadDecisions> {
    if (input.context.work && (!input.time || (input.context.time && input.context.time !== input.time)))
      input.context.work.unavailable('Access metered ReadDecisions requires the same live native AuthoritativeTime');
    const requested = [...input.actions];
    if (!validReadDecisionActions(input, actions)) throw new RangeError('Invalid read decision actions');
    const admitted = new Set(requested);
    const typeActions =
      input.typeActions && new Map([...input.typeActions].map(([type, values]) => [type, new Set(values)]));
    const grantRolesByAction = new Map(
      requested.map((action) => [
        action,
        [...catalogue.roles].filter(([, values]) => values.includes(action)).map(([role]) => role),
      ]),
    );
    const { actor, context } = input;
    const deadline = accessEvidenceDeadline(context.deadline);
    const pool = deadlineClient(context.pool, deadline) as typeof context.pool;
    try {
      return await within(deadline, async () => {
        const account = actor.kind === 'account' ? config.accountEvidence(actor, context) : undefined;
        if (actor.kind === 'account' && (!account || !eligible(account, actor)))
          throw new AccessUnavailableError('overloaded');
        const identity =
          actor.kind === 'account' ? Object.freeze({ ...actor, scopes: Object.freeze([...actor.scopes]) }) : actor;
        const recorded = await readPermissionTime(
          pool,
          input.time ? () => new Date(authoritativeTimeValue(input.time!)) : config.clock,
          context.work,
        );
        if (!recorded?.databaseAt) throw new AccessUnavailableError('overloaded');
        const at = recorded.at;
        let principalId: string | null = null;
        let assignmentRoute: number | null = null;
        let assignmentRequestId: string | null = null;
        const members: { route: number; account_id: string }[] = [];
        if (identity.kind === 'account' && account) {
          if (account.operatorAccountId === null)
            members.push({ route: routeOf(identity.accountId), account_id: identity.accountId });
          if (identity.requestedBy !== null) {
            const request = requestedByPattern.exec(identity.requestedBy);
            if (!request) throw new AccessUnavailableError('overloaded');
            principalId = request[1]!;
            assignmentRoute = routeOf(principalId);
            assignmentRequestId = request[2]!;
            const assignmentInput = {
              route: assignmentRoute,
              principal_id: principalId,
              request_id: assignmentRequestId,
              actor_id: identity.accountId,
              at,
            };
            const assignment = await accessNativeWork(context.work, 'assignment', assignmentInput, {}, () =>
              assignmentRead.run(pool, assignmentInput),
            );
            if (!assignment || assignment.kind !== 'actor' || assignment.state !== 'active' || assignment.fenced)
              throw new AccessUnavailableError('overloaded');
            if (principalId !== identity.accountId && assignment.operatorAccountId === null)
              members.push({ route: assignmentRoute, account_id: principalId });
            if (principalId === identity.accountId && assignment.operatorAccountId !== null) members.length = 0;
          }
        }
        const roles: RoleEvidence[] = [];
        if (members.length) {
          const inverseInput = { route: members[0]!.route, account_id: members[0]!.account_id, members };
          const inverse = await accessNativeWork(
            context.work,
            'inverse',
            inverseInput,
            { members: members.length, groups: MEMBERSHIP_LIMIT },
            () => inverseRead.run(pool, inverseInput),
          );
          for (const member of members) {
            const entries = inverse.filter((row) => row.accountId === member.account_id);
            if (!entries.length || entries.some((row) => !row.complete)) throw new AccessUnavailableError('overloaded');
            const groups = entries.filter((row) => row.id !== null || row.kind !== null);
            if (groups.length > MEMBERSHIP_LIMIT || new Set(groups.map((row) => row.id)).size !== groups.length)
              throw new AccessUnavailableError('overloaded');
            for (const group of groups) {
              if (
                !group.id ||
                !uuidPattern.test(group.id) ||
                group.id === member.account_id ||
                (group.kind !== 'organization' && group.kind !== 'realm')
              )
                throw new AccessUnavailableError('overloaded');
              for (const role of ['owner', 'member'] as const)
                roles.push({
                  account_id: member.account_id,
                  organization_id: group.id,
                  group_kind: group.kind,
                  role,
                  member: false,
                  valid: 'empty',
                });
            }
          }
        }
        const anchors = roles.filter((row) => row.role === 'owner');
        const organizations = anchors.filter((row) => row.group_kind === 'organization');
        if (organizations.length) {
          const first = organizations[0]!;
          const membershipInput = {
            route: routeOf(first.organization_id),
            organization_id: first.organization_id,
            member_id: first.account_id,
            at,
            pairs: organizations.map((row) => ({
              route: routeOf(row.organization_id),
              organization_id: row.organization_id,
              member_id: row.account_id,
            })),
          };
          const proofs = await accessNativeWork(
            context.work,
            'membership',
            membershipInput,
            { groups: organizations.length },
            () => membershipRead.run(pool, membershipInput),
          );
          const indexed = new Map(
            proofs.map((proof) => [`${proof.accountId}/${proof.organizationId}/${proof.role}`, proof]),
          );
          if (proofs.length !== organizations.length * 2 || indexed.size !== proofs.length)
            throw new AccessUnavailableError('overloaded');
          for (const row of roles.filter((row) => row.group_kind === 'organization')) {
            const proof = indexed.get(`${row.account_id}/${row.organization_id}/${row.role}`);
            if (!proof || proof.kind !== 'organization' || typeof proof.member !== 'boolean' || !proof.valid)
              throw new AccessUnavailableError('overloaded');
            row.member = proof.member;
            row.valid = proof.valid;
          }
        }
        const realms = anchors.filter((row) => row.group_kind === 'realm');
        if (realms.length) {
          const realmInput = {
            pairs: realms.map((row) => ({ realmId: row.organization_id, accountId: row.account_id })),
            at,
          };
          const proofs = await accessOwnerWork(
            context.work,
            'Content AccessRealmRoleReader.batch',
            config.realmRoleReader?.batchWork,
            realmInput,
            () => {
              if (kindOriginalInvocation.getStore())
                throw new AccessWorkUnavailableError(
                  'Content AccessRealmRoleReader.batch: original Kind Source-eight-axis callback declaration',
                );
              return config.realmRoleReader?.batch?.(pool, realmInput) ?? Promise.resolve(null);
            },
          );
          if (!proofs || proofs.length !== realms.length * 2) throw new AccessUnavailableError('overloaded');
          const indexed = new Map(proofs.map((proof) => [`${proof.accountId}/${proof.realmId}/${proof.role}`, proof]));
          if (indexed.size !== proofs.length) throw new AccessUnavailableError('overloaded');
          for (const row of roles.filter((row) => row.group_kind === 'realm')) {
            const proof = indexed.get(`${row.account_id}/${row.organization_id}/${row.role}`);
            if (!proof || typeof proof.member !== 'boolean' || !proof.valid)
              throw new AccessUnavailableError('overloaded');
            row.member = proof.member;
            row.valid = proof.valid;
          }
        }
        const origin = Date.parse(recorded.databaseAt);
        if (!Number.isFinite(origin)) throw new AccessUnavailableError('overloaded');
        const databaseDeadline = new Date(origin + Math.max(0, deadline - recorded.observedAt)).toISOString();
        requireAccessDeadline(deadline);
        // The permission clock query above already observed authoritative T. Mint
        // its opaque read token from that observation without a second SQL read.
        const time =
          input.time ??
          (await mintReadTime({
            query: (async () => ({
              rows: [{ at }],
              rowCount: 1,
              command: 'SELECT',
              oid: 0,
              fields: [],
            })) as AccessClient['query'],
          }));
        async function decide(
          client: AccessClient,
          batch: import('../request/access.ts').ReadDecisionInput,
          decisionTime?: AuthoritativeTime,
          borrowedScope?: string,
        ): Promise<Readonly<Record<string, AccessDecision>>> {
          const gate = borrowedScope !== undefined;
          if (context.work && decisionTime !== input.time)
            context.work.unavailable('Access metered ReadDecisions final T differs from its preparation window');
          if (
            !batch ||
            (!gate && !admitted.has(batch.action)) ||
            (!gate && typeActions !== undefined && !typeActions.get(batch.resourceType)?.has(batch.action)) ||
            typeof batch.resourceType !== 'string' ||
            !batch.resourceType.length ||
            !Array.isArray(batch.ids) ||
            batch.ids.length < 1 ||
            batch.ids.length > 200 ||
            batch.ids.some((id) => typeof id !== 'string' || readRoute(id) === null) ||
            new Set(batch.ids).size !== batch.ids.length
          )
            throw new RangeError('Invalid read decision batch');
          const ids = Object.freeze([...batch.ids]);
          const ownAccount = !gate && actions.get(batch.action)?.authority === 'own-account';
          if (
            ownAccount &&
            (identity.kind !== 'account' ||
              batch.resourceType !== 'access.account' ||
              batch.ids.length !== 1 ||
              batch.ids[0] !== identity.accountId)
          )
            throw new RangeError('Invalid own-account authority');
          const action = batch.action;
          const eligibility = batch.eligibility;
          try {
            requireAccessDeadline(deadline);
            return await within(deadline, async () => {
              const bounded = deadlineClient(client, deadline);
              const scope = identity.kind === 'account' && identity.scopes.includes(borrowedScope ?? batch.action);
              const policyCore = action === 'collection:read';
              const formulaInput = {
                route: 0,
                resource_ids: [...ids],
                batch: true,
                include_explicit: scope,
                include_public: !gate && !policyCore && actions.get(action)!.anonymous,
                include_global: isGlobalReachAction(action),
                policy_core: policyCore,
                action,
                own_account: ownAccount,
                actor_id: identity.kind === 'account' ? identity.accountId : '',
                principal_id: principalId ?? '',
                assignment_route: assignmentRoute,
                assignment_request_id: assignmentRequestId,
                anonymous: policyCore ? identity.kind === 'anonymous' : !scope,
                floor: false,
                at: decisionTime ? authoritativeTimeValue(decisionTime) : '',
                roles,
                grant_roles: gate
                  ? [
                      ...resolveResourceRoles(
                        new Map([...actions, [action, { anonymous: false }]]),
                        config.resourceRoles,
                      ).roles,
                    ]
                      .filter(([, values]) => values.includes(action))
                      .map(([role]) => role)
                  : grantRolesByAction.get(action)!,
                deadline: databaseDeadline,
              };
              const rows = await accessNativeWork(
                context.work,
                'formula',
                formulaInput,
                {
                  targets: ids.length,
                  roles: roles.length,
                  members: identity.kind === 'account' ? (principalId ? 2 : 1) : 0,
                  grantRoles: formulaInput.grant_roles.length,
                  explicit: formulaInput.include_explicit,
                  public: formulaInput.include_public,
                  global: formulaInput.include_global,
                  assignment: assignmentRequestId !== null,
                },
                () => permissionRead.run(bounded, formulaInput),
              );
              requireAccessDeadline(deadline);
              if (
                rows.length !== ids.length ||
                new Set(rows.map((row) => row.resourceId)).size !== ids.length ||
                rows.some(
                  (row) =>
                    !ids.includes(row.resourceId) ||
                    (policyCore ? typeof row.live !== 'boolean' : typeof row.allowed !== 'boolean') ||
                    (!policyCore && typeof row.explicit !== 'boolean') ||
                    !row.at ||
                    !row.live,
                )
              )
                throw new AccessUnavailableError('overloaded');
              const eligibilityInput = { client: bounded, ids, at: rows[0]!.at! };
              const floor = eligibility
                ? await accessOwnerWork(
                    context.work,
                    'Resource ReadDecisionEligibility',
                    eligibility.work,
                    eligibilityInput,
                    () => eligibility(bounded, ids, eligibilityInput.at),
                  )
                : undefined;
              requireAccessDeadline(deadline);
              if (eligibility && (!floor || typeof floor !== 'object')) throw new AccessUnavailableError('overloaded');
              const result: Record<string, AccessDecision> = Object.create(null);
              for (const row of rows) {
                const id = row.resourceId;
                if (!id || (floor && typeof floor[id] !== 'boolean')) throw new AccessUnavailableError('overloaded');
                if (policyCore) {
                  const input = {
                    action,
                    resourceType: batch.resourceType,
                    anonymous: identity.kind === 'anonymous',
                    hasPrincipal: principalId !== null,
                    authenticatedBenefit: false,
                    scope,
                    floor: floor?.[id] === true,
                  };
                  const projection = row as unknown as NativePermissionProjection;
                  const ordinary = decideNativePermission(policyCatalogue, { ...input, mode: 'ordinary' }, projection);
                  const explicit =
                    scope && identity.kind === 'account'
                      ? decideNativePermission(
                          policyCatalogue,
                          { ...input, floor: false, mode: 'explicit' },
                          projection,
                        )
                      : undefined;
                  result[id] = Object.freeze({
                    allowed: ordinary.decision === 'allow',
                    explicit: explicit !== undefined && explicit.decision === 'allow',
                  });
                } else {
                  result[id] = Object.freeze({
                    allowed: row.allowed || (floor?.[id] === true && row.publicAllowed === true),
                    explicit: row.explicit === true,
                  });
                }
              }
              return Object.freeze(result);
            });
          } catch (error) {
            context.work?.fail(error);
            throwAccessUnavailable(error, deadline);
            throw new AccessUnavailableError('overloaded');
          }
        }
        const handle: ReadDecisions = Object.freeze({
          decide: (client, batch, time) => decide(client, batch, time),
          async prepareAccountAuthority(requestedIds): Promise<AccountAuthority> {
            if (
              context.work &&
              ['account:read', 'account:update', 'account:manage'].some((action) => !admitted.has(action))
            )
              context.work.unavailable(
                'Access AccountAuthority current account/operator projection native work producer',
              );
            if (
              !requestedIds.length ||
              requestedIds.length > 100 ||
              new Set(requestedIds).size !== requestedIds.length ||
              requestedIds.some((id) => readRoute(id) === null) ||
              ['account:read', 'account:update', 'account:manage'].some(
                (action) => !admitted.has(action) || (typeActions && !typeActions.get('access.account')?.has(action)),
              )
            )
              throw new RangeError('Invalid Account authority batch');
            requireAccessDeadline(deadline);
            authoritativeTimeValue(time);
            const ids = Object.freeze([...requestedIds]);
            const subjects = new Map(
              (await readNativeAccountStates(pool, ids, context.work)).map((row) => [row.id, row]),
            );
            const foreignIds = [
              ...new Set([
                ...(identity.kind === 'account' ? [identity.accountId] : []),
                ...[...subjects.values()].flatMap((row) =>
                  row.kind === 'actor' && row.operatorAccountId ? [row.operatorAccountId] : [],
                ),
              ]),
            ];
            type AccountState = Awaited<ReturnType<typeof readAccountActionStates>>[number];
            const foreign = new Map<string, AccountState>();
            for (let offset = 0; offset < foreignIds.length; offset += 100)
              for (const row of await readNativeAccountStates(
                pool,
                foreignIds.slice(offset, offset + 100),
                context.work,
              ))
                foreign.set(row.id, row);
            const live = (row: AccountState | undefined) => row?.state === 'active' && !row.fenced;
            const acting = identity.kind === 'account' ? foreign.get(identity.accountId) : undefined;
            const currentActor =
              identity.kind === 'account' &&
              live(acting) &&
              acting?.kind === 'actor' &&
              Number.isSafeInteger(identity.authnEpoch) &&
              identity.authnEpoch >= 1 &&
              BigInt(acting.minimumAuthnEpoch) <= BigInt(identity.authnEpoch);
            const anchors = new Map<string, Set<string>>();
            const add = (action: string, id: string) => {
              const values = anchors.get(action) ?? new Set<string>();
              values.add(id);
              anchors.set(action, values);
            };
            for (const subject of subjects.values()) {
              if (!live(subject)) continue;
              const anchor = accountProfileAuthorityAnchor(subject, subject.id);
              add(anchor.action, anchor.id);
              if (identity.kind === 'account' && subject.id === identity.accountId) {
                add('account:read', subject.id);
                add('account:update', subject.id);
              }
              if (subject.kind === 'organization') add('account:manage', subject.id);
            }
            const answers = new Map<string, Readonly<Record<string, AccessDecision>>>();
            if (currentActor && !context.work)
              for (const [action, keys] of anchors)
                answers.set(
                  action,
                  await decide(pool, { action, resourceType: 'access.account', ids: [...keys] }, time),
                );
            requireAccessDeadline(deadline);
            authoritativeTimeValue(time);
            // The handle binds identity, T, actions, full target keys and CURRENT
            // operator relationship. Metered grants are evaluated only at final T.
            return Object.freeze({
              async decide(client, batch, decisionTime = time) {
                if (
                  (context.work && decisionTime !== time) ||
                  authoritativeTimeValue(decisionTime) !== authoritativeTimeValue(time) ||
                  !['profile', 'self', 'verification'].includes(batch.kind) ||
                  !['account:read', 'account:update'].includes(batch.action) ||
                  (batch.kind === 'profile' && batch.action !== 'account:update') ||
                  !batch.ids.length ||
                  batch.ids.length > 100 ||
                  new Set(batch.ids).size !== batch.ids.length ||
                  batch.ids.some((id) => !ids.includes(id))
                )
                  throw new RangeError('Invalid Account authority binding');
                return within(deadline, async () => {
                  // No pool checkout or foreign callback is hidden in final work.
                  // All full-key statements use the caller's supplied read client.
                  const finalForeign = context.work ? new Map<string, AccountState>() : foreign;
                  if (context.work) {
                    for (let offset = 0; offset < foreignIds.length; offset += 100)
                      for (const row of await readNativeAccountStates(
                        deadlineClient(client, deadline),
                        foreignIds.slice(offset, offset + 100),
                        context.work,
                      ))
                        finalForeign.set(row.id, row);
                  }
                  const finalActing = identity.kind === 'account' ? finalForeign.get(identity.accountId) : undefined;
                  const finalActor =
                    currentActor &&
                    (!context.work ||
                      (live(finalActing) &&
                        finalActing?.kind === 'actor' &&
                        finalActing.operatorAccountId === acting?.operatorAccountId &&
                        BigInt(finalActing.minimumAuthnEpoch) <=
                          BigInt(identity.kind === 'account' ? identity.authnEpoch : 0)));
                  const finalAnswers = context.work
                    ? new Map<string, Readonly<Record<string, AccessDecision>>>()
                    : answers;
                  if (context.work && finalActor)
                    for (const [action, keys] of anchors)
                      finalAnswers.set(
                        action,
                        await decide(client, { action, resourceType: 'access.account', ids: [...keys] }, decisionTime),
                      );
                  const current = new Map(
                    (await readNativeAccountStates(deadlineClient(client, deadline), batch.ids, context.work)).map(
                      (row) => [row.id, row],
                    ),
                  );
                  const result: Record<string, AccountAuthorityDecision> = Object.create(null);
                  for (const id of batch.ids) {
                    const before = subjects.get(id);
                    const row = current.get(id);
                    const profile = accountProfileAuthorityAnchor(before, id);
                    let action = batch.action;
                    let anchor = id;
                    let eligible =
                      finalActor &&
                      live(row) &&
                      row?.kind === before?.kind &&
                      row?.operatorAccountId === before?.operatorAccountId;
                    if (batch.kind === 'profile') {
                      action = profile.action;
                      anchor = profile.id;
                      eligible = eligible && (!profile.operatorId || live(finalForeign.get(profile.operatorId)));
                    } else if (batch.kind === 'self') {
                      eligible = eligible && identity.kind === 'account' && identity.accountId === id;
                    } else {
                      const self = identity.kind === 'account' && identity.accountId === id;
                      action = self ? batch.action : 'account:manage';
                      eligible =
                        eligible &&
                        finalActing?.operatorAccountId === null &&
                        ((self && row?.kind === 'actor') || (!self && row?.kind === 'organization'));
                    }
                    const answer = finalAnswers.get(action)?.[anchor];
                    result[id] = Object.freeze({
                      action,
                      allowed: eligible && answer?.allowed === true,
                      explicit: eligible && answer?.explicit === true,
                    });
                  }
                  requireAccessDeadline(deadline);
                  authoritativeTimeValue(decisionTime);
                  return Object.freeze(result);
                }).catch((error: unknown) => {
                  context.work?.fail(error);
                  throw error;
                });
              },
            });
          },
        });
        readEvidence.set(handle, {
          time,
          async gate(client, action, clientAction, resource) {
            if (!/^gate:(?:any|[a-z][a-z_-]{0,62})$/.test(action)) return false;
            const result = await decide(
              client,
              { action, resourceType: 'semantic.context', ids: [resource.id] },
              time,
              clientAction,
            );
            return result[resource.id]?.allowed === true;
          },
        });
        return handle;
      });
    } catch (error) {
      context.work?.fail(error);
      throwAccessUnavailable(error, deadline);
      throw new AccessUnavailableError('overloaded');
    }
  }
  const access: Access = {
    kindAudience: createKindAudienceOriginal({
      ...(config.kindOriginal ? { identity: config.kindOriginal } : {}),
      formulaDigest:
        'sha256:' +
        createHash('sha256')
          .update(
            JSON.stringify([
              permissionRead.sql,
              inverseRead.sql,
              assignmentRead.sql,
              membershipRead.sql,
              [...actions],
              [...catalogue.roles],
              MEMBERSHIP_LIMIT,
            ]),
          )
          .digest('hex'),
      formulaBound: (request) =>
        kindOriginalFormulaPlan(request.actor, request.context, actions, config.resourceRoles).access,
      formulaOverhead: (request) =>
        kindOriginalFormulaPlan(request.actor, request.context, actions, config.resourceRoles).overhead,
      prepareFormula: (input) => kindOriginalInvocation.run(true, () => prepareReadDecisions(input)),
      async gates(request, root) {
        const state = await readExposure(
          request.context.pool,
          'collections',
          request.context.time,
          request.context.deadline,
          request.context.work,
          request.context.time,
        );
        if (state.open) return true;
        if (request.actor.kind !== 'account') return false;
        return accessCheckout(request.context.work, () =>
          withConnection(request.context.pool, async (client) => {
            for (const action of ['gate:collections', 'gate:any'])
              if (
                await authorizePreparedReadGate(
                  root,
                  deadlineClient(client, request.context.deadline),
                  action,
                  'collection:read',
                  GLOBAL_CONTEXT,
                )
              )
                return true;
            return false;
          }),
        );
      },
    }),
    prepareReadDecisions,
    replayAuthorization: (action) => actions.get(action)?.replay,
    authenticate:
      config.authenticate ??
      (async () => {
        throw new AuthenticationError(401, 'Bearer error="invalid_token"');
      }),
    prepare: (actor, action, resource, context) => preparePermission(actor, action, resource, context),
    preparePage(actor, action, input, context) {
      const page = resourcePage(input);
      return preparePermission(actor, action, { route: page.route, id: page.ids[0]! }, context, page);
    },
    async authorizePage(client, actor, action, input, evidence, time) {
      const page = resourcePage(input);
      const resource = { route: page.route, id: page.ids[0]! };
      const { allowed } = await checkPreparedPermission(
        client,
        actor,
        action,
        resource,
        evidence,
        time,
        config.clock,
        page,
      );
      const use = allowed ? governanceReachUse(evidence, actor, action, resource) : undefined;
      if (use && hasLiveCommandTransaction(client) && !recordGovernanceReachUse(client, use)) return false;
      return allowed;
    },
    async authorizeExplicit(client, actor, action, target, evidence, time) {
      const page = 'ids' in target ? resourcePage(target) : undefined;
      const resource = page ? { route: page.route, id: page.ids[0]! } : (target as Resource);
      const decision = await checkPreparedPermission(
        client,
        actor,
        action,
        resource,
        evidence,
        time,
        config.clock,
        page,
        true,
      );
      const use = decision.allowed ? governanceReachUse(evidence, actor, action, resource) : undefined;
      if (use && hasLiveCommandTransaction(client) && !recordGovernanceReachUse(client, use))
        return { allowed: false, explicit: false };
      return { allowed: decision.allowed, explicit: decision.explicit };
    },
    async authorize(client, actor, action, resource, evidence, time) {
      const allowed = await checkPermission(client, actor, action, resource, evidence, time, config.clock);
      const use = allowed ? governanceReachUse(evidence, actor, action, resource) : undefined;
      // Standalone checks have no write effect. Command authorizers that prove
      // on another connection must retain this same use and record it later.
      if (use && hasLiveCommandTransaction(client) && !recordGovernanceReachUse(client, use)) return false;
      return allowed;
    },
  };
  installPreparedAccessCheckWork(access, preparedCheckWork);
  installAccountStandingCheck(access, async ({ accountId, action, target, context }) => {
    const page = 'ids' in target ? resourcePage(target) : undefined;
    const resource = page ? { route: page.route, id: page.ids[0]! } : (Object.freeze({ ...target }) as Resource);
    const ids = page?.ids ?? [resource.id];
    const denied = () => Object.freeze(Object.fromEntries(ids.map((id) => [id, false])));
    const deadline = accessEvidenceDeadline(context.deadline, ACCESS_EVIDENCE_TTL_MS);
    try {
      requireAccessDeadline(deadline);
      if (!uuidPattern.test(accountId)) return denied();
      // Copy only the admitted fields. In particular, an effect's command T and
      // any caller-provided session/delegation fields cannot enter this check.
      const currentContext: AccessContext = {
        pool: deadlineClient(context.pool, deadline) as typeof context.pool,
        deadline,
        ...(context.work ? { work: context.work } : {}),
      };
      return await within(deadline, async () => {
        const account = context.work
          ? await readNativePermissionAccount(currentContext.pool, accountId, context.work)
          : await readAccount(currentContext.pool, routeOf(accountId), accountId);
        if (!account || account.kind !== 'actor' || account.state !== 'active' || account.fenced) return denied();
        const authnEpoch = Number(account.minimumAuthnEpoch > 1n ? account.minimumAuthnEpoch : 1n);
        if (!Number.isSafeInteger(authnEpoch)) return denied();
        const actor: AccountActor = Object.freeze({
          kind: 'account',
          accountId,
          clientId: STANDING_CLIENT_ID,
          scopes: standingScopes,
          requestedBy: null,
          authnEpoch,
        });
        standingAccounts.set(actor, account);
        let ownedTime: AuthoritativeTime | undefined;
        try {
          if (context.work) {
            ownedTime = await readNativeAccessTime(currentContext, config.clock);
            currentContext.time = ownedTime;
          }
          const evidence = await preparePermission(actor, action, resource, currentContext, page, true);
          return await accessCheckout(context.work, () =>
            withConnection(currentContext.pool, async (client) => {
              const decision = await checkPreparedPermission(
                deadlineClient(client, deadline),
                actor,
                action,
                resource,
                evidence,
                ownedTime,
                config.clock,
                page,
              );
              return decision.decisions ?? denied();
            }),
          );
        } finally {
          if (ownedTime) releaseOperationalTime(ownedTime);
          standingAccounts.delete(actor);
        }
      });
    } catch (error) {
      context.work?.fail(error);
      throwAccessUnavailable(error, deadline);
      throwEvidenceFailure(error);
      return denied();
    }
  });
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
      } catch (error) {
        throwAccessUnavailable(error, context.deadline);
        throwEvidenceFailure(error);
        return false;
      }
    };
  } catch (error) {
    throwAccessUnavailable(error, context.deadline);
    throwEvidenceFailure(error);
    return async () => false;
  }
}
