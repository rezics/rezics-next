import type { CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';

export type ContextRoleProvenance = Readonly<{
  occurrence: string;
  resourceId: string;
  resourceType: 'semantic.context';
  originalCreator: string;
  accountId: string;
  grantRole: string;
  valid: string | null;
  side: 'creator' | 'new' | 'former';
  grantTransaction: string | null;
  sourceTransaction: string;
  contextKey: string | null;
  delivery: 'pending' | 'delivered' | 'not-applicable';
}>;

/** Native role occurrences, not a permission decision or assertion of current ownership. Seek
 * the exact account prefix within one physical resource home; no lost OLD grant is reconstructed. */
export async function readContextRoleProvenance(
  tx: CommandTransaction,
  input: { resource: Resource; accountId: string; after?: string },
): Promise<readonly ContextRoleProvenance[]> {
  if (input.after !== undefined && !/^[0-9]{1,19}$/.test(input.after))
    throw new TypeError('Invalid role occurrence cursor');
  const result = await tx.query<ContextRoleProvenance>(
    `SELECT occurrence::text,resource_id::text AS "resourceId",resource_type AS "resourceType",
       original_creator::text AS "originalCreator",account_id::text AS "accountId",grant_role AS "grantRole",
       valid::text,side,grant_transaction::text AS "grantTransaction",source_transaction::text AS "sourceTransaction",
       context_key::text AS "contextKey",delivery
     FROM access.resource_role_provenance
     WHERE route=$1 AND account_id=$2 AND resource_id=$3 AND resource_type='semantic.context' AND occurrence>$4
     ORDER BY occurrence LIMIT 8`,
    [input.resource.route, input.accountId, input.resource.id, input.after ?? '0'],
  );
  return result.rows;
}

/** The Semantic native record_erasure_locator sink is not present in this checkout. Keep the
 * exact provenance row pending until that owner supplies its real receiving port; do not call a
 * guessed function or mark a former holder delivered from a Context lookup alone. */
export async function deliverContextRoleProvenance(
  tx: CommandTransaction,
  input: { route: number; occurrence: string },
): Promise<boolean> {
  void tx;
  void input;
  return false;
}
