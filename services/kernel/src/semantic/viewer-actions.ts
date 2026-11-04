import { authorizedContextMetadata, contextNativeActions } from './context-lifecycle-read.ts';
import { ContextDirectoryPreparingError } from './context-directory.ts';
import {
  readViewerActions,
  type ViewerActionBinding,
  type ViewerActionBindings,
  type ViewerActionResource,
  type ViewerActionResources,
} from '../access/viewer-actions.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { ViewerActionResources } from '../access/viewer-actions.ts';
import type { Access, AccessClient, Actor } from '../request/access.ts';
import type { Pool } from 'pg';
import { routeOf } from '../route/route.ts';
import read from './viewer-actions.sql';
import { GLOBAL_CONTEXT } from './definitions.ts';

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

export type SubjectCorrectionActions =
  | { state: 'available'; actions: { action: string; operations: string[] }[] }
  | { state: 'concealed' | 'stale' | 'unavailable' };

/** Read the mounted proposal operation against its actual Global parent and recheck its target. */
export async function readSubjectCorrectionActions(input: {
  pool: Pool;
  access: Access;
  bindings: ViewerActionBindings;
  actor: Actor;
  clock: () => Date;
  subject: string;
  type: string;
  revision: number;
  deadline: number;
}): Promise<SubjectCorrectionActions> {
  const route = routeOf(input.subject);
  if (
    route === null ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.revision >= Number.MAX_SAFE_INTEGER
  )
    return { state: 'unavailable' };
  const mounted = (input.bindings.get('semantic.revision') ?? []).filter(
    (binding) => binding.action === 'statement:propose' && binding.operationId === 'subject.propose',
  );
  if (
    !mounted.length ||
    mounted.some(
      (binding) => binding.authority !== 'resource' || binding.fixedResourceId !== undefined || binding.accountAuthority,
    )
  )
    return { state: 'unavailable' };
  let witness: 'pending' | 'ready' | 'concealed' | 'stale' = 'pending';
  const inputSubject = input.subject;
  const inputType = input.type;
  const inputRevision = input.revision;
  const inputRoute = route;
  const sourceBoundContext: ViewerActionResource = {
    readAction: contextViewerActionResource.readAction,
    async read(client, ids, at, time) {
      return contextViewerActionResource.read(client, ids, at, time);
    },
    async prepare(input) {
      const prepared = await contextViewerActionResource.prepare!(input);
      return {
        ...prepared,
        async read(client, ids, at, time) {
          if (!ids.includes(GLOBAL_CONTEXT)) return {};
          const subjects = await readSubjectPublicStates(client, [inputSubject]);
          const subject = subjects.find((row) => row.id === inputSubject);
          if (subject?.visibility !== 'visible' || subject.type !== inputType) {
            witness = 'concealed';
            return {};
          }
          const current = await client.query<{ revision: number }>(
            `SELECT revision FROM semantic.revision WHERE route=$1 AND subject_id=$2
             ORDER BY revision DESC LIMIT 1`,
            [inputRoute, inputSubject],
          );
          if (current.rows[0]?.revision !== inputRevision) {
            witness = current.rows.length ? 'stale' : 'concealed';
            return {};
          }
          witness = 'ready';
          return prepared.read(client, ids, at, time);
        },
      };
    },
  };
  const resources: ViewerActionResources = new Map([['semantic.context', sourceBoundContext]]);
  const bindings: ViewerActionBindings = new Map([
    [
      'semantic.context',
      mounted.map(
        ({ action, operationId, exposure }) =>
          ({ action, operationId, exposure, authority: 'resource' }) satisfies ViewerActionBinding,
      ),
    ],
  ]);
  try {
    const result = await readViewerActions(
      { pool: input.pool, access: input.access, resources, bindings, clock: input.clock },
      input.actor,
      [{ type: 'semantic.context', id: GLOBAL_CONTEXT }],
      input.deadline,
    );
    if (witness === 'concealed') return { state: 'concealed' };
    if (witness === 'stale') return { state: 'stale' };
    const selected = result.resources[0];
    if (!selected || 'error' in selected || witness !== 'ready') return { state: 'unavailable' };
    return {
      state: 'available',
      actions: selected.viewerActions.filter(
        (entry) => entry.action === 'statement:propose' && entry.operations.includes('subject.propose'),
      ),
    };
  } catch {
    return witness === 'concealed' || witness === 'stale' ? { state: witness } : { state: 'unavailable' };
  }
}
