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

const capabilities = new WeakMap<ResourceEligibility, object>();

/** Snapshot identity/action and retain callbacks without executing domain code. */
export function createResourceAnonymousEligibility<E>(options: ResourceEligibilityOptions<E>): ResourceEligibility {
  const capability = Object.freeze({}) as ResourceEligibility;
  capabilities.set(
    capability,
    Object.freeze({
      resource: Object.freeze({ route: options.resource.route, id: options.resource.id }),
      action: options.action,
      prepare: options.prepare,
      verify: options.verify,
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

/** Replacement seam for the full floor evaluator, including all attempt bindings.
 * No eligibility can authorize until that evaluator is implemented.
 */
export async function evaluateResourceEligibility(eligibility: ResourceEligibility): Promise<boolean> {
  if (!capabilities.has(eligibility)) return false;
  throw new ResourceEligibilityUnavailableError();
}
