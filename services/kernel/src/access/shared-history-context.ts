import type { CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';

export type ContextRoleProvenance = Readonly<{
  occurrence: string; resourceId: string; resourceType: 'semantic.context'; originalCreator: string;
  accountId: string; grantRole: string; valid: string | null; side: 'creator' | 'new' | 'former';
  grantTransaction: string | null; sourceTransaction: string; contextKey: string | null;
  delivery: 'pending' | 'delivered' | 'not-applicable';
}>;

/** Native role occurrences, not a permission decision or assertion of current ownership. Seek
 * the exact account prefix within one physical resource home; no lost OLD grant is reconstructed. */
export async function readContextRoleProvenance(
  tx: CommandTransaction, input: { resource: Resource; accountId: string; after?: string },
): Promise<readonly ContextRoleProvenance[]> {
  if (input.after !== undefined && !/^[0-9]{1,19}$/.test(input.after)) throw new TypeError('Invalid role occurrence cursor');
  const result = await tx.query<ContextRoleProvenance>(
    `SELECT occurrence::text,resource_id::text AS "resourceId",resource_type AS "resourceType",
       original_creator::text AS "originalCreator",account_id::text AS "accountId",grant_role AS "grantRole",
       valid::text,side,grant_transaction::text AS "grantTransaction",source_transaction::text AS "sourceTransaction",
       context_key::text AS "contextKey",delivery
     FROM access.resource_role_provenance
     WHERE route=$1 AND account_id=$2 AND resource_id=$3 AND resource_type='semantic.context' AND occurrence>$4
     ORDER BY occurrence LIMIT 8`, [input.resource.route,input.accountId,input.resource.id,input.after ?? '0']);
  return result.rows;
}

/** Repairs one exact pending delivery after its receiving Context becomes available. The owning
 * sink retains its native invalidation/delivery/late-item protocol; no foreign SQL writer or ACK. */
export async function deliverContextRoleProvenance(tx: CommandTransaction, input: { route: number; occurrence: string }): Promise<boolean> {
  const result = await tx.query(
    `SELECT p.*,c.erasure_key FROM access.resource_role_provenance p
     JOIN semantic.context c ON c.route=p.route AND c.context_id=p.resource_id
     WHERE p.route=$1 AND p.occurrence=$2 AND p.resource_type='semantic.context'
       AND p.grant_role='semantic.context.owner' AND p.delivery='pending' FOR UPDATE OF p`,
    [input.route,input.occurrence]);
  const row = result.rows[0];
  if (!row) return false;
  await tx.query("SELECT semantic.record_erasure_locator($1,$2,'owner','context',$3,$4,NULL)",
    [input.route >>> 4,row.account_id,row.erasure_key,row.source_transaction]);
  await tx.query("UPDATE access.resource_role_provenance SET delivery='delivered',context_key=$3 WHERE route=$1 AND occurrence=$2",
    [input.route,input.occurrence,row.erasure_key]);
  return true;
}
