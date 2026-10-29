import { accessEvidence } from './evidence.ts';
import { requireAccessDeadline } from './unavailable.ts';
import { within } from './authenticate.ts';
import type { AccessClient, AccessContext, Actor, Resource } from '../request/access.ts';

declare const resourceEligibility: unique symbol;
/** Server capability only; serialized input and structural copies carry no authority. */
export type ResourceEligibility = { readonly [resourceEligibility]: true };
export type ResourceIdentity = Readonly<Pick<Resource, 'route' | 'id'>>;
export type ResourceEligibilityPrepareContext = Readonly<{
  actor: Actor;
  action: string;
  resource: ResourceIdentity;
  pool: AccessContext['pool'];
  deadline: number;
}>;
export type ResourceEligibilityVerifyContext<E> = Readonly<{
  client: AccessClient;
  actor: Actor;
  action: string;
  resource: ResourceIdentity;
  evidence: E;
  /** Authoritative server/database T, supplied by the evaluator. */
  at: string;
  deadline: number;
}>;
export type ResourceEligibilityOptions<E> = Readonly<{
  resource: Resource;
  action: string;
  /** Trusted owning-module code; runs before resource checkout. Gather bounded,
   * separately anchored container/revision evidence here. Missing evidence denies.
   */
  prepare(context: ResourceEligibilityPrepareContext): Promise<E>;
  /** Revalidate current domain state, revisions and the bound container chain on
   * the supplied resource client at T, with no nested checkout or cross-anchor join.
   * False disables only the floor. Throw for unavailable required disclosure or a
   * hard domain restriction so the independent grant branch also fails closed.
   */
  verify(context: ResourceEligibilityVerifyContext<E>): Promise<boolean>;
}>;

type Binding = Readonly<{ actor: Actor; action: string; resource: Resource; deadline: number }>;
type Verify = (client: AccessClient, at: string) => Promise<boolean>;
type Capability = {
  resource: ResourceIdentity;
  action: string;
  prepare(context: ResourceEligibilityPrepareContext): Promise<Verify>;
};
const capabilities = new WeakMap<ResourceEligibility, Capability>();
const observations = new WeakMap<object, { token: ResourceEligibility; verify: Verify; deadline: number }>();

/** Generic anonymous-action domain capability, never an authorization boolean.
 * Snapshot identity/action and callbacks without executing domain code. Command
 * callbacks prove that action's current prerequisites (including verified captcha
 * when required), not public readability of its newly created private resource.
 * Authentication alone never supplies those prerequisites.
 */
export function createResourceAnonymousEligibility<E extends {}>(
  options: Omit<ResourceEligibilityOptions<E>, 'prepare'> & {
    prepare(context: ResourceEligibilityPrepareContext): Promise<E | null | undefined>;
  },
): ResourceEligibility;
export function createResourceAnonymousEligibility<E>(options: ResourceEligibilityOptions<E>): ResourceEligibility;
export function createResourceAnonymousEligibility<E>(options: ResourceEligibilityOptions<E>): ResourceEligibility {
  const { prepare, verify } = options;
  const capability = Object.freeze({}) as ResourceEligibility;
  capabilities.set(
    capability,
    Object.freeze({
      resource: Object.freeze({ route: options.resource.route, id: options.resource.id }),
      action: options.action,
      async prepare(context: ResourceEligibilityPrepareContext) {
        const evidence = await accessEvidence(() => prepare(context), false, context.deadline);
        if (evidence === null || evidence === undefined) throw new Error('Missing resource eligibility evidence');
        return async (client: AccessClient, at: string) =>
          (await verify(
            Object.freeze({
              actor: context.actor,
              action: context.action,
              resource: context.resource,
              deadline: context.deadline,
              client,
              at,
              evidence,
            }),
          )) === true;
      },
    }),
  );
  return capability;
}

/** Public-read form of the same capability and evaluator. The owning reader must
 * prove CURRENT publication and revisions of the resource AND its container chain
 * at T. Catalogue admission and authorship provide no publication authority.
 */
export const createResourcePublicEligibility = createResourceAnonymousEligibility;

export class ResourceEligibilityUnavailableError extends Error {
  constructor() {
    super('Resource eligibility evaluation is unavailable');
    this.name = 'ResourceEligibilityUnavailableError';
  }
}

/** A factory alone is never permission proof. Direct evaluation without the
 * evaluator's prepared actor/resource/deadline and authoritative T is unavailable.
 */
export async function evaluateResourceEligibility(
  eligibility: ResourceEligibility,
  attempt?: { evidence: unknown; client: AccessClient; at: string },
): Promise<boolean> {
  if (!capabilities.has(eligibility)) return false;
  if (!attempt) throw new ResourceEligibilityUnavailableError();
  const facts =
    typeof attempt.evidence === 'object' && attempt.evidence !== null ? observations.get(attempt.evidence) : undefined;
  if (facts) requireAccessDeadline(facts.deadline);
  if (!facts || facts.token !== eligibility || !Number.isFinite(Date.parse(attempt.at))) return false;
  const result = await within(facts.deadline, () =>
    accessEvidence(() => facts.verify(attempt.client, attempt.at), false, facts.deadline),
  );
  requireAccessDeadline(facts.deadline);
  return result === true;
}

/** Prepare bounded owning-module evidence before resource checkout. Each check
 * binds the exact capability, actor, action, resource and deadline independently.
 * The returned verifier runs on EVERY attempt at the SQL formula's shared T.
 * Public readers must recheck publication and revisions for the resource and all
 * containers using O(H) anchored reads, where the owning route bounds H.
 * False leaves the independent grant/scope branch available. Missing evidence or
 * exceptions deny the whole check, including unavailable required disclosure.
 */
export async function prepareAnonymousEligibility(
  binding: Binding,
  context: AccessContext,
): Promise<Verify | undefined> {
  requireAccessDeadline(context.deadline);
  const { eligibility, anonymousEligibility } = binding.resource;
  if (eligibility !== undefined && anonymousEligibility !== undefined && eligibility !== anonymousEligibility)
    throw new Error('Conflicting resource eligibility capabilities');
  const token = eligibility ?? anonymousEligibility;
  if (token === undefined) return undefined;
  const capability = capabilities.get(token);
  if (
    !capability ||
    capability.action !== binding.action ||
    capability.resource.route !== binding.resource.route ||
    capability.resource.id !== binding.resource.id
  )
    throw new Error('Invalid resource eligibility capability');
  const resource = Object.freeze({ route: binding.resource.route, id: binding.resource.id });
  const verify = await capability.prepare(
    Object.freeze({
      actor: binding.actor,
      action: binding.action,
      resource,
      pool: context.pool,
      deadline: binding.deadline,
    }),
  );
  const evidence = Object.freeze({});
  observations.set(evidence, { token, verify, deadline: binding.deadline });
  return (client, at) => evaluateResourceEligibility(token, { evidence, client, at });
}
