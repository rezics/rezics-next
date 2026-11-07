import { memoizedValue } from '../../memoized.ts';
import { statementBytes } from '../../database/statement-bytes.ts';
import type { IdentitySourceWorkDeclaration } from '../identity-source-consumer-ports.ts';
import type { WorkDimensions } from '../../library/contract/work-dimensions.ts';
import acceptedAccountClaim from '../identity-epoch-binding-accepted-account.sql';
import retainedReference from '../identity-source-consumer-custody-select.sql';

/** Exact existing SQL and operand bounds. Access composes these producer bodies with
 * its local reader/settlement and selected Core controls, without copying the SQL.
 */
function declaration(
  statement: { sql: string; source?: string },
  rows: number,
  points: number,
  emptySeeks: number,
  extraBytes: number,
): IdentitySourceWorkDeclaration {
  const work: WorkDimensions = Object.freeze({
    candidateKeys: 0,
    nativeRows: rows,
    identityMetadataRows: 0,
    nativePoints: points,
    witnessKeys: 0,
    statements: 1,
    bytes: statementBytes(statement) + extraBytes,
    emptySeeks,
  });
  return Object.freeze({ work, engineRequests: 0 });
}

export function accountIdentityAcceptedBindingDeclaration(): IdentitySourceWorkDeclaration {
  return memoizedValue(accountIdentityAcceptedBindingDeclaration, () =>
    declaration(acceptedAccountClaim, 5, 5, 1, 4 + 36 + 64 + 8192 + 36),
  );
}

export function accountIdentityRetainedReferenceDeclaration(): IdentitySourceWorkDeclaration {
  return memoizedValue(accountIdentityRetainedReferenceDeclaration, () =>
    declaration(retainedReference, 6, 6, 1, 4 + 64 + 64 + 8 + 36 + 36 + 8 + 36 + 4 + 64),
  );
}
