import { bundledRelease } from '@rezics/definitions/bundled';
import type { ViewerActionResources } from '../access/viewer-actions.ts';
import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import read from './viewer-actions.sql';

/** Shared native evidence for ordinary subject disclosure and personal batches. */
export async function readSubjectPublicStates(client: AccessClient, ids: readonly string[]) {
  return read.run(client, { routes: ids.map((id) => routeOf(id)!), ids: [...ids] });
}

/** Register the released semantic catalogue, including namespaced type identifiers. */
export const subjectViewerActionResources: ViewerActionResources = new Map(
  Object.keys(bundledRelease.types).map((type) => [
    type,
    {
      readAction: 'subject:read',
      async read(client, ids) {
        const rows = await readSubjectPublicStates(client, ids);
        // Hidden subjects are absent even if a caller independently holds subject:read.
        return Object.fromEntries(
          rows.filter((row) => row.type === type && row.visibility === 'visible').map((row) => [row.id, true]),
        );
      },
    },
  ]),
);
