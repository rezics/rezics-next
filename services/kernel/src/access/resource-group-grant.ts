import type { CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
import { grantSubject } from './grant-subject.ts';
import { requireResourceCommand, ResourceAccessWriteDeniedError } from './resource-denials.ts';
import statement from './resource-group-grant.sql';

export type RealmGroupGrant = {
  resource: Resource;
  principal: { kind: 'realm'; id: string };
  role: 'owner' | 'member';
  resourceRole: string;
};

const resourceRoleName = /^[a-z][a-z0-9_.-]*$/;

/** Writes one identity `resource_role_grant` from the command's T for a Realm owner or member group.
 * A current member holds `resourceRole` through that row; a former member stops when the membership proof ends.
 */
export async function grantGroupRole(tx: CommandTransaction, input: RealmGroupGrant): Promise<void> {
  const at = requireResourceCommand(tx, input.resource);
  const principal = input.principal;
  const keys = principal && typeof principal === 'object' ? Object.keys(principal) : [];
  const subject =
    keys.length === 2 && keys.includes('kind') && keys.includes('id') && principal.kind === 'realm'
      ? grantSubject({ kind: 'realm', id: principal.id, role: input.role })
      : null;
  if (
    !subject ||
    subject.role !== input.role ||
    typeof input.resourceRole !== 'string' ||
    !resourceRoleName.test(input.resourceRole)
  )
    throw new ResourceAccessWriteDeniedError();
  const row = await statement.run(tx, {
    route: input.resource.route,
    resource_id: input.resource.id,
    subject_id: subject.id,
    subject_role: subject.role,
    grant_role: input.resourceRole,
    at,
    transaction_id: Bun.randomUUIDv7(),
  });
  if (row.outcome !== 'open' && row.outcome !== 'inserted') throw new ResourceAccessWriteDeniedError();
}
