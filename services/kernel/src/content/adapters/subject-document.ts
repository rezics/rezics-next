import type { Pool } from 'pg';
import type { CommandTransaction } from '../../command/command.ts';
import type { RecordHistorySourceReference } from '../../history/contract/index.ts';
import type { Access, Actor } from '../../request/access.ts';
import { readAuthoredFieldHistorySource } from '../authored-fields-history.ts';
import { readImportedFieldHistorySource } from '../imported-fields-history.ts';
import { readDocument } from '../document-read.ts';

export type CurrentContentDocumentRuntime = Readonly<{
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  now: () => number;
}>;

export type CurrentContentDocumentRequest = Readonly<{
  id: string;
  actor: Actor;
  deadline: number;
  maxSourceBytes?: number;
}>;

/** Native Semantic reads consume Content's current document authority through this adapter. */
export function readCurrentContentDocument(
  runtime: CurrentContentDocumentRuntime,
  request: CurrentContentDocumentRequest,
) {
  return readDocument(
    { pool: runtime.pool, access: runtime.access, routeKey: runtime.routeKey, now: runtime.now },
    request.id,
    { actor: request.actor, deadline: request.deadline },
    request.maxSourceBytes,
  );
}

/** Resolve immutable source lineage from the actual Content owner row in the caller's native command. */
export async function readContentDocumentHistorySource(
  tx: CommandTransaction,
  id: string,
): Promise<Extract<RecordHistorySourceReference, { kind: 'contribution' }> | null> {
  const authored = await readAuthoredFieldHistorySource(tx, id);
  if (authored) return authored;
  return readImportedFieldHistorySource(tx, id);
}
