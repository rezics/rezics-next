import { readEntityProjection } from '../entity-page/read.ts';
import type { SuppliedClient } from './read.ts';

/** Share the current projection with mounted discussions; an injected reader keeps its own cache entry. */
export function readCurrentWorkProjection(id: string, client?: SuppliedClient) {
  return client ? readEntityProjection(id, undefined, client) : readEntityProjection(id, undefined);
}
