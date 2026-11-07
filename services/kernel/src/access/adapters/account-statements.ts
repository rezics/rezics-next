/** Access-owned account SQL descriptors. Library progress planning consumes these; it does not import the SQL. */

import { memoizedValue } from '../../memoized.ts';
import accountRead from '../account-read.sql';
import accountShare from '../account-share.sql';
import type { AccessAccountStatementDeclaration } from '../contract/index.ts';

type QueryText = Readonly<{ sql: string; params?: readonly string[] }>;

function descriptor(
  query: QueryText,
  nativeRows: number,
  nativePoints: number,
  resultBytes: number,
  identityMetadataRows = 0,
) {
  return Object.freeze({
    sql: query.sql,
    ...(query.params ? { params: query.params } : {}),
    nativeRows,
    nativePoints,
    identityMetadataRows,
    resultBytes,
  });
}

/** Account row work stays on Access's native work port. Library charges statement text and original binds only. */
export function accessAccountStatements(): AccessAccountStatementDeclaration {
  return memoizedValue(accessAccountStatements, () =>
    Object.freeze({
      'account-read': descriptor(accountRead, 0, 0, 0),
      'account-share': descriptor(accountShare, 1, 1, 256),
    }),
  );
}
