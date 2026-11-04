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
import type { Access, AccessClient, Actor } from '../request/access.ts';
import type { Pool, PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import read from './viewer-actions.sql';
import { GLOBAL_CONTEXT, readRelease } from './definitions.ts';
import { relationSlotForApi } from './item.ts';
import {
  readStatementDisclosure,
  readStatementRetraction,
  statementDisclosureTargetOwnedBy,
} from './statement-disclosure.ts';

/** Shared native evidence for ordinary subject disclosure and personal batches. */
export async function readSubjectPublicStates(client: AccessClient, ids: readonly string[]) {
  return read.run(client, { routes: ids.map((id) => routeOf(id)!), ids: [...ids] });
}

/** Native Subject points supply both generic disclosure and exact released-Type disclosure. */
function subjectViewerActionResource(type?: string): ViewerActionResource {
  return {
    readAction: 'subject:read',
    async read(client, ids) {
      const rows = await readSubjectPublicStates(client, ids);
      // Hidden subjects are absent even if a caller independently holds subject:read.
      return Object.fromEntries(
        rows
          .filter((row) => (type === undefined || row.type === type) && row.visibility === 'visible')
          .map((row) => [row.id, true]),
      );
    },
  };
}

/** Register generic Subject disclosure and the released catalogue, including namespaced Types. */
export const subjectViewerActionResources: ViewerActionResources = new Map([
  ['semantic.subject', subjectViewerActionResource()],
  ...Object.keys(bundledRelease.types).map((type): [string, ViewerActionResource] => [
    type,
    subjectViewerActionResource(type),
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
          keys.map((id) => {
            const actions = Object.fromEntries(
              ['context:read', 'context:create', 'context:delete', 'context:restore'].map((action) => [
                action,
                available[id]?.includes(action) ?? false,
              ]),
            );
            return [
              id,
              {
                ...actions,
                'context:accept': visible.get(id)?.state === 'active',
                'context:adopt': visible.get(id)?.state === 'active',
                'statement:propose': id === GLOBAL_CONTEXT,
              },
            ];
          }),
        );
      },
    };
  },
};

export type SubjectCorrectionActions =
  | { state: 'available'; actions: { action: string; operations: string[] }[] }
  | { state: 'concealed' | 'stale' | 'unavailable' };

/** Read mounted current correction operations against their Global parent and recheck the Subject. */
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
  const correctionOperations = new Set(['subject.propose', 'subject.terms']);
  const mounted = (input.bindings.get('semantic.context') ?? []).filter(
    (binding) => binding.action === 'statement:propose' && correctionOperations.has(binding.operationId),
  );
  if (
    !mounted.length ||
    mounted.some(
      (binding) =>
        binding.authority !== 'resource' || binding.fixedResourceId !== GLOBAL_CONTEXT || binding.accountAuthority,
    )
  )
    return { state: 'unavailable' };
  const witness: { state: 'pending' | 'ready' | 'concealed' | 'stale' } = { state: 'pending' };
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
            witness.state = 'concealed';
            return {};
          }
          const current = await client.query<{ revision: number }>(
            `SELECT revision FROM semantic.revision WHERE route=$1 AND subject_id=$2
             ORDER BY revision DESC LIMIT 1`,
            [inputRoute, inputSubject],
          );
          if (current.rows[0]?.revision !== inputRevision) {
            witness.state = current.rows.length ? 'stale' : 'concealed';
            return {};
          }
          witness.state = 'ready';
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
          ({
            action,
            operationId,
            exposure,
            authority: 'resource',
            fixedResourceId: GLOBAL_CONTEXT,
          }) satisfies ViewerActionBinding,
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
    if (witness.state === 'concealed') return { state: 'concealed' };
    if (witness.state === 'stale') return { state: 'stale' };
    const selected = result.resources[0];
    if (!selected || 'error' in selected || witness.state !== 'ready') return { state: 'unavailable' };
    return {
      state: 'available',
      actions: selected.viewerActions.flatMap((entry) => {
        if (entry.action !== 'statement:propose') return [];
        const operations = [...new Set(entry.operations.filter((operation) => correctionOperations.has(operation)))];
        return operations.length ? [{ action: entry.action, operations }] : [];
      }),
    };
  } catch {
    return witness.state === 'concealed' || witness.state === 'stale'
      ? { state: witness.state }
      : { state: 'unavailable' };
  }
}

export type StatementConsentActions =
  | { state: 'available'; disclosed: boolean; operations: ('statement.disclose' | 'statement.retract')[] }
  | { state: 'refused' | 'terminal' | 'unavailable' };

/** Read current consent operations through the mounted Global Context catalogue and native candidate custody. */
export async function readStatementConsentActions(input: {
  pool: Pool;
  access: Access;
  bindings: ViewerActionBindings;
  actor: Actor;
  clock: () => Date;
  subject: string;
  candidate: string;
  property: string;
  slot: { target?: string; sameAs?: string; key?: string };
  deadline: number;
}): Promise<StatementConsentActions> {
  const route = routeOf(input.candidate);
  if (route === null || routeOf(input.subject) === null || input.actor.kind !== 'account') return { state: 'refused' };
  const accountId = input.actor.accountId;
  const mounted = (input.bindings.get('semantic.context') ?? []).filter(
    (binding) =>
      binding.action === 'statement:propose' &&
      (binding.operationId === 'statement.disclose' || binding.operationId === 'statement.retract') &&
      binding.authority === 'resource' &&
      binding.fixedResourceId === GLOBAL_CONTEXT &&
      !binding.accountAuthority,
  );
  const operationIds = new Set(mounted.map((binding) => binding.operationId));
  if (!operationIds.has('statement.disclose') || !operationIds.has('statement.retract'))
    return { state: 'unavailable' };

  const observation: { state: 'pending' | 'ready' | 'refused' | 'terminal'; disclosed?: boolean } = {
    state: 'pending',
  };
  const exactContext: ViewerActionResource = {
    ...contextViewerActionResource,
    async prepare(preparation) {
      const prepared = await contextViewerActionResource.prepare!(preparation);
      return {
        ...prepared,
        async read(client, ids, at, time) {
          const contexts = await prepared.read(client, ids, at, time);
          if (!contexts[GLOBAL_CONTEXT]) {
            observation.state = 'refused';
            return {};
          }
          const disclosure = await readStatementDisclosure(client as PoolClient, input.candidate);
          if (
            !disclosure ||
            disclosure.subject_id !== input.subject ||
            disclosure.property !== input.property
          ) {
            observation.state = 'refused';
            return {};
          }
          const statement = disclosure.statement as {
            references?: unknown[];
            value?: { type?: string; content?: unknown };
          };
          if (
            !Array.isArray(statement?.references) ||
            statement.references.length ||
            statement.value?.type !== 'value'
          ) {
            observation.state = 'refused';
            return {};
          }
          const target = statement.value.content;
          if (typeof target !== 'string') {
            observation.state = 'refused';
            return {};
          }
          const release = await readRelease(client as PoolClient, disclosure.release);
          if (!release) throw new Error('Consent release is unavailable');
          const property = release.properties[input.property];
          if (
            property?.disclosure !== 'sourceOrConsent' ||
            relationSlotForApi(input.subject, input.property, property.relation, input.slot) !== disclosure.slot_id
          ) {
            observation.state = 'refused';
            return {};
          }
          if (!(await statementDisclosureTargetOwnedBy(client as PoolClient, target, accountId))) {
            observation.state = 'refused';
            return {};
          }
          const retraction = await readStatementRetraction(client as PoolClient, input.subject, input.candidate);
          if (retraction) {
            observation.state = 'terminal';
            return {};
          }
          observation.state = 'ready';
          observation.disclosed = disclosure.disclosed;
          return contexts;
        },
        async actionAvailability(_client, ids) {
          return Object.fromEntries(ids.map((id) => [id, { 'statement:propose': observation.state === 'ready' }]));
        },
      };
    },
  };
  const bindings: ViewerActionBindings = new Map([
    [
      'semantic.context',
      mounted.map(({ action, operationId, exposure }) => ({ action, operationId, exposure, authority: 'resource' })),
    ],
  ]);
  try {
    const result = await readViewerActions(
      {
        pool: input.pool,
        access: input.access,
        resources: new Map([['semantic.context', exactContext]]),
        bindings,
        clock: input.clock,
      },
      input.actor,
      [{ type: 'semantic.context', id: GLOBAL_CONTEXT }],
      input.deadline,
    );
    if (observation.state === 'terminal') return { state: 'terminal' };
    if (observation.state === 'refused') return { state: 'refused' };
    if (observation.state !== 'ready' || observation.disclosed === undefined) return { state: 'unavailable' };
    const selected = result.resources[0];
    if (!selected || 'error' in selected) return { state: 'refused' };
    const operations = selected.viewerActions
      .filter((entry) => entry.action === 'statement:propose')
      .flatMap((entry) => entry.operations)
      .filter(
        (operation): operation is 'statement.disclose' | 'statement.retract' =>
          (operation === 'statement.disclose' || operation === 'statement.retract') &&
          (operation !== 'statement.disclose' || !observation.disclosed),
      );
    return operations.length
      ? { state: 'available', disclosed: observation.disclosed, operations }
      : { state: 'refused' };
  } catch {
    return observation.state === 'terminal'
      ? { state: 'terminal' }
      : observation.state === 'refused'
        ? { state: 'refused' }
        : { state: 'unavailable' };
  }
}
