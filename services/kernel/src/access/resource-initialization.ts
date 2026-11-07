import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
import { GrantDeniedError } from './resource-access-errors.ts';
import { creationCapability } from './parent-creation.ts';
import { resourceRoleCatalogue } from './resource-roles.ts';
import { ACTIVE_ACCOUNTS, grantSubject } from './grant-subject.ts';
import initialize from './resource-initialization.sql';

/** Called INSIDE the owning module's new-resource transaction, after its unique
 * resource INSERT. The parentCreationAuthorization capability fixes the creator,
 * exact child resource, partition and shared attempt T. This writes role IDs,
 * never action copies, and never opens a connection/command. Completion follows
 * successful native writes; finalization rejects missing or failed entries even
 * when the body catches errors.
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
  const capability = await creationCapability(tx, resource, creator, type);
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
    transaction_id: currentCommand(tx).transactionId,
  });
  if (rows.length !== grants.length) throw new GrantDeniedError();
  await tx.query(
    `INSERT INTO access.resource_role_provenance
     (route,resource_id,resource_type,original_creator,account_id,grant_role,side,source_transaction)
     VALUES($1,$2,$3,$4,$4,'','creator',$5)`,
    [resource.route, resource.id, type, creator, currentCommand(tx).transactionId],
  );
  // Data-modifying CTE siblings share a snapshot: an INSERT trigger on the grant can miss
  // the initialization inserted by the sibling CTE. Read both native rows in this next statement.
  await tx.query(
    `INSERT INTO access.resource_role_provenance
     (route,resource_id,resource_type,original_creator,account_id,grant_role,valid,side,grant_transaction,source_transaction)
     SELECT g.route,g.resource_id,i.resource_type,i.creator_id,g.subject_id,g.grant_role,g.valid,'new',g.transaction_id,$3
     FROM access.resource_role_grant g JOIN access.resource_initialization i USING(route,resource_id)
     WHERE g.route=$1 AND g.resource_id=$2 AND g.subject_kind='identity' AND g.subject_role=''
       AND g.transaction_id=$3 AND NOT EXISTS(SELECT 1 FROM access.resource_role_provenance p
         WHERE p.route=g.route AND p.resource_id=g.resource_id AND p.account_id=g.subject_id
           AND p.grant_role=g.grant_role AND p.side='new' AND p.source_transaction=$3)`,
    [resource.route, resource.id, currentCommand(tx).transactionId],
  );
  capability.complete();
}
