import { authoritativeTimeValue, type CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
import { GrantDeniedError } from './grant-commands.ts';
import { creationCapability } from './parent-creation.ts';
import { resourceRoleCatalogue } from './resource-roles.ts';
import { ACTIVE_ACCOUNTS, grantSubject } from './grant-subject.ts';
import initialize from './resource-initialization.sql';

/** Called INSIDE the owning module's new-resource transaction, after its unique
 * resource INSERT. The parentCreationAuthorization capability fixes the creator,
 * exact child resource, partition and shared attempt T. This writes role IDs,
 * never action copies, and never opens a connection/command. Any failure must
 * propagate out of the command body so the resource/outbox/receipt roll back.
 * Empty trusted templates (reports/communal subjects) intentionally grant none.
 */
export async function initializeResourceGrants(
  tx: CommandTransaction,
  input: {
    resource: Resource;
    type: string;
    creator: string;
  },
): Promise<void> {
  const { resource, type, creator } = input;
  const capability = await creationCapability(tx, resource, creator);
  const template = resourceRoleCatalogue(capability.access)?.types.get(type);
  if (!template) throw new GrantDeniedError();
  const grants = template.standing.map((role) => ({
    subject_kind: 'active_accounts',
    subject_id: grantSubject(ACTIVE_ACCOUNTS)!.id,
    grant_role: role,
  }));
  if (template.owner) grants.push({ subject_kind: 'identity', subject_id: creator, grant_role: template.owner });
  const rows = await initialize.run(tx, {
    route: resource.route,
    resource_id: resource.id,
    resource_type: type,
    creator_id: creator,
    at: authoritativeTimeValue(capability.time),
    grants,
    transaction_id: Bun.randomUUIDv7(),
  });
  if (rows.length !== grants.length) throw new GrantDeniedError();
}
