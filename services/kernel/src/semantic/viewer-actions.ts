import { authorizedContextMetadata, contextNativeActions } from './context-lifecycle-read.ts';
import { ContextDirectoryPreparingError } from './context-directory.ts';
import type { ViewerActionResource } from '../access/viewer-actions.ts';
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
export const subjectViewerActionResources: ViewerActionResources = new Map([
  [
    'semantic.subject',
    {
      readAction: 'subject:read',
      async read(client, ids) {
        const rows = await readSubjectPublicStates(client, ids);
        return Object.fromEntries(rows.filter((row) => row.visibility === 'visible').map((row) => [row.id, true]));
      },
    },
  ],
  ...Object.keys(bundledRelease.types).map((type): [string, ViewerActionResource] => [
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
]);

/** Native Context resolver shares the exact directory lifecycle reader; candidates and creators never grant. */
export const contextViewerActionResource: ViewerActionResource = {
  readAction: 'context:read',
  async read() {
    throw new ContextDirectoryPreparingError();
  },
  async prepare({ pool, access, actor, ids, deadline }) {
    const entries = await authorizedContextMetadata({ pool, access }, { actor, ids, deadline });
    const visible = new Map(entries.map((entry) => [entry.id, entry]));
    return {
      readAction: 'context:read',
      async read(client, keys, at) {
        const rows = await client.query<{ id: string; state: string; labels: Record<string, string> }>(
          `SELECT context_id::text AS id,state,labels FROM semantic.context
           WHERE (route,context_id) IN (SELECT * FROM unnest($1::int[],$2::uuid[]))
             AND (state='active' OR (state='deleted' AND $3::timestamptz<purge_after))`,
          [keys.map((id) => routeOf(id)!), [...keys], at],
        );
        return Object.fromEntries(
          rows.rows
            .filter((row) => {
              const prepared = visible.get(row.id);
              return (
                prepared &&
                prepared.state === row.state &&
                JSON.stringify(prepared.labels) === JSON.stringify(row.labels)
              );
            })
            .map((row) => [row.id, true]),
        );
      },
      async actionAvailability(client, keys, actor, time) {
        const available = await contextNativeActions(client, keys, actor, time);
        return Object.fromEntries(
          keys.map((id) => [
            id,
            {
              ...Object.fromEntries(
                ['context:read', 'context:create', 'context:delete', 'context:restore'].map((action) => [
                  action,
                  available[id]?.includes(action) ?? false,
                ]),
              ),
              'context:accept': visible.get(id)?.state === 'active',
              'context:adopt': visible.get(id)?.state === 'active',
            },
          ]),
        );
      },
    };
  },
};
