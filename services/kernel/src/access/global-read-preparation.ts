import type { Access, AccessContext, Actor, Resource } from '../request/access.ts';
import { accessEvidenceDeadline } from './evidence-deadline.ts';
import type { ResourceEligibility } from './eligibility.ts';

type Inputs = {
  deadline: number;
  context?: { kind: string };
  clock?: { at: string; databaseAt: string | undefined; observedAt: number };
};
type Page = {
  actor: Actor;
  pool: AccessContext['pool'];
  deadline: number;
  owner?: Access;
  inputs?: Inputs;
};
const pages = new WeakMap<ResourceEligibility, Page>();
const preparations = new WeakMap<AccessContext['pool'], Inputs>();

/** These two distinct capabilities may share only their preparatory native inputs. */
export function pairGlobalReadPreparation(
  actor: Actor,
  { pool, deadline }: AccessContext,
  presentation: ResourceEligibility,
  subjects: ResourceEligibility,
) {
  if (actor.kind !== 'anonymous') return;
  const page = { actor, pool, deadline };
  pages.set(presentation, page);
  pages.set(subjects, page);
}

export function bindGlobalReadPreparation(
  owner: Access,
  actor: Actor,
  resource: Resource,
  original: AccessContext,
  bounded: AccessContext,
) {
  const page = resource.eligibility && pages.get(resource.eligibility);
  if (
    !page ||
    actor !== page.actor ||
    original.pool !== page.pool ||
    original.deadline !== page.deadline ||
    bounded.deadline !== page.deadline ||
    (page.owner && page.owner !== owner)
  )
    return;
  page.owner = owner;
  if (!page.inputs || Date.now() >= page.inputs.deadline)
    page.inputs = { deadline: accessEvidenceDeadline(page.deadline) };
  // The factory creates a new bounded pool facade for each preparation.
  preparations.set(bounded.pool, page.inputs);
}

export function globalReadPreparation(pool: AccessContext['pool']) {
  return preparations.get(pool);
}
