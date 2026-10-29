import type { Pool } from 'pg';
import { actingCommandAccount, commandAccessContext, requireCommandAdmission } from '../access/command-admission.ts';
import { admitGroup } from '../access/gates/admission.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { throwAccessUnavailable } from '../access/unavailable.ts';
import { authoritativeTimeValue, type CommandAttempt } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

/** Native identity admission precedes all private lifecycle evidence, including replay. */
export async function admitEntryAttempt(
  deps: { pool: Pool; access: Access; clock?: KernelClock },
  actor: Actor,
  action: 'library_entry:delete' | 'library_entry:update',
  attempt: CommandAttempt,
  deadline: number,
): Promise<void> {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action))
    throw new GrantDeniedError();
  try {
    const context = commandAccessContext({ pool: deps.pool, deadline }, attempt);
    await requireCommandAdmission(deps.access, actor, context);
    const current = await actingCommandAccount(deps.access, actor, context);
    if (!current || current.kind !== 'actor' || current.state !== 'active' || current.fenced)
      throw new GrantDeniedError();
  } catch (error) {
    throwAccessUnavailable(error, deadline);
    throw new GrantDeniedError();
  }
  await admitGroup({
    pool: deps.pool,
    access: () => deps.access,
    actor,
    group: 'personal_library',
    clientAction: action,
    deadline,
    clock: () => new Date(authoritativeTimeValue(attempt.time)),
  });
}
