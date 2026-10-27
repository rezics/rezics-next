import { admitGroup } from '../access/gates/admission.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { SHELF_PROGRESS_ACTION, SHELF_PROGRESS_GATE, type ShelfAdmissionDependencies } from './shelf-contract.ts';

export async function admitShelfRead(deps: ShelfAdmissionDependencies, actor: Actor, deadline: number): Promise<void> {
  if (actor.kind !== 'account' || !actor.scopes.includes(SHELF_PROGRESS_ACTION)) throw new ProblemError('forbidden');
  await admitGroup({
    pool: deps.pool,
    access: () => deps.access,
    actor,
    group: SHELF_PROGRESS_GATE,
    clientAction: SHELF_PROGRESS_ACTION,
    deadline,
    clock: deps.clock,
  });
}
