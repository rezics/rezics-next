import type { Pool } from 'pg';
import type { Access, Actor } from '../../request/access.ts';
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
