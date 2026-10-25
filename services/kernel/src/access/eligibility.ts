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
  /** Trusted owning-module code; runs before resource checkout. */
  prepare(context: ResourceEligibilityPrepareContext): Promise<E>;
  /** Runs on the supplied resource client at T; no pool is available. */
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

/** Snapshot identity/action and retain callbacks without executing domain code. */
export function createResourceAnonymousEligibility<E>(options: ResourceEligibilityOptions<E>): ResourceEligibility {
  const capability = Object.freeze({}) as ResourceEligibility;
  capabilities.set(
    capability,
    Object.freeze({
      resource: Object.freeze({ route: options.resource.route, id: options.resource.id }),
      action: options.action,
      async prepare(context: ResourceEligibilityPrepareContext) {
        const evidence = await options.prepare(context);
        if (evidence === null || evidence === undefined) throw new Error('Missing resource eligibility evidence');
        return async (client: AccessClient, at: string) =>
          (await options.verify({ ...context, client, at, evidence })) === true;
      },
    }),
  );
  return capability;
}

/** Public and other anonymous eligibility use one capability and evaluator. */
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
export async function evaluateResourceEligibility(eligibility: ResourceEligibility): Promise<boolean> {
  if (!capabilities.has(eligibility)) return false;
  throw new ResourceEligibilityUnavailableError();
}

/** Prepare bounded owning-module evidence before resource checkout. Each check
 * binds the exact capability, actor, action, resource and deadline independently.
 * The returned verifier runs on EVERY attempt at the SQL formula's shared T.
 * Public readers must recheck publication and revisions for the resource and all
 * containers using O(H) anchored reads, where the owning route bounds H.
 * False leaves the independent grant/scope branch available. Missing evidence or
 * exceptions deny the whole check, including unavailable required disclosure.
 */
export async function prepareAnonymousEligibility(binding: Binding, context: AccessContext): Promise<Verify | undefined> {
  const { eligibility, anonymousEligibility } = binding.resource;
  if (eligibility !== undefined && anonymousEligibility !== undefined && eligibility !== anonymousEligibility)
    throw new Error('Conflicting resource eligibility capabilities');
  const token = eligibility ?? anonymousEligibility;
  if (token === undefined) return undefined;
  const capability = capabilities.get(token);
  if (!capability || capability.action !== binding.action ||
      capability.resource.route !== binding.resource.route || capability.resource.id !== binding.resource.id)
    throw new Error('Invalid resource eligibility capability');
  const resource = Object.freeze({ route: binding.resource.route, id: binding.resource.id });
  const verify = await capability.prepare(Object.freeze({
    actor: binding.actor, action: binding.action, resource, pool: context.pool, deadline: binding.deadline,
  }));
  return async (client, at) => {
    if (Date.now() >= binding.deadline || !Number.isFinite(Date.parse(at))) return false;
    const result = await verify(client, at);
    return result && Date.now() < binding.deadline;
  };
}
