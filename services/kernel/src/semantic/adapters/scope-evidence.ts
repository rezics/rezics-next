import type { Pool } from 'pg';
import type { Access, Actor, AccessClient, AccessCheck } from '../../request/access.ts';
import { accessCheck } from '../../request/access.ts';
import type { AccessWorkAccounting } from '../../access/work.ts';
import { routeOf } from '../../route/route.ts';
import type { ScopeEvidenceHost, ScopeEvidenceObservation } from '../contract/index.ts';
type Dependencies = Readonly<{ pool: Pool; access: Access }>;
type Context = Readonly<{ actor: Actor; deadline: number; work: AccessWorkAccounting }>;
import { subjectReadEligibility } from '../eligibility.ts';
import referenceRead from '../read-subject-reference.sql';
import subjectState from '../scope-leaf-evidence-eligibility.sql';
import type { ScopeEvidenceReader } from '../contract/index.ts';
import type { AuthoritativeTime } from '../../command/command.ts';
import type { ScopeWorkContext } from '../../search/adapters/index.ts';
export type NativeScopeReader = ScopeEvidenceReader<Access, Actor, AuthoritativeTime, ScopeWorkContext>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function route(id: string): number {
  const value = typeof id === 'string' && uuid.test(id) ? routeOf(id) : null;
  if (value === null) throw new TypeError('Invalid Realm Subject candidate identity');
  return value;
}

async function prepareAccess(dependencies: Dependencies, context: Context, id: string): Promise<AccessCheck> {
  const identity = { id, route: route(id) };
  const eligibility = subjectReadEligibility(identity);
  if (!dependencies.access.prepare) context.work.unavailable('Content Realm Subject native Access preparation');
  const check = await accessCheck(
    dependencies.access,
    context.actor,
    'subject:read',
    { ...identity, eligibility },
    {
      pool: dependencies.pool,
      deadline: context.deadline,
      work: context.work,
    },
  );
  if (!check.work) context.work.unavailable(`Content Realm Subject subject:read native work producer`);
  return check;
}

/** Exact original reference and terminal state; no redirect replacement or publication inference. */
export function createSubjectScopeEvidence<A>(host: ScopeEvidenceHost<Dependencies, Context, AccessClient, A>) {
  return { observe: observeSubject };
  async function observeSubject(
    dependencies: Dependencies,
    subjectId: string,
    context: Context,
  ): Promise<ScopeEvidenceObservation<A> | null> {
    const check = await prepareAccess(dependencies, context, subjectId);
    const observed = await host.snapshot(dependencies, subjectId, context, async (client) => {
      const input = { route: route(subjectId), subject_id: subjectId };
      const reference = await host.point(client, 'subject.reference', referenceRead, input, 2);
      const state = await host.point(client, 'subject.state', subjectState, input);
      if (!reference || !state || !(await check(client))) return null;
      return { reference, state };
    });
    const value = observed.value;
    if (!value || value.reference.id !== subjectId || value.reference.redirect !== null) return null;
    return { signature: host.hash(value), anchors: [observed.anchor] };
  }
}
