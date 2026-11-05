import { t } from 'elysia';
import type { AccessWorkAccounting } from './work.ts';
import type { Pool } from 'pg';
import { Compile } from 'typebox/compile';
import type { Static, TSchema } from 'typebox';
import { deadlineClient } from './authenticate.ts';
import { authorizePlatformGate, viewerActionReadTime } from './index.ts';
import { GLOBAL_CONTEXT } from './gates/catalogue.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import { parseExposure, type Exposure } from './gates/declaration.ts';
import openGroups from './gates/open-groups.sql';
import { authoritativeTimeValue, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { createApp } from '../http/app.ts';
import { actionLabelOfMountedRoute, type MountedRoute } from '../http/request.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import {
  prepareReadDecisions,
  type Access,
  type AccessClient,
  type Actor,
  type AccountAuthorityKind,
} from '../request/access.ts';
import { routeOf } from '../route/route.ts';

/** Trusted owner read, shared with its ordinary resource reader. Absence and the
 * public floor are separate: a private resource may still have an explicit grant. */
export type ViewerActionResource = Readonly<{
  readAction: string;
  /** Native owner may prepare foreign anchors before the target connection is held. */
  prepare?(input: {
    pool: Pool;
    access: Access;
    actor: Actor;
    ids: readonly string[];
    deadline: number;
  }): Promise<ViewerActionResource>;
  /** Additional native state/target constraints; missing action keys preserve the mounted catalogue. */
  actionAvailability?(
    client: AccessClient,
    ids: readonly string[],
    actor: Actor,
    time: import('../command/command.ts').AuthoritativeTime,
  ): Promise<Readonly<Record<string, Readonly<Record<string, boolean>>>>>;
  read(
    client: AccessClient,
    ids: readonly string[],
    at: string,
    time?: AuthoritativeTime,
    work?: AccessWorkAccounting,
  ): Promise<Readonly<Record<string, boolean>>>;
}>;
export type ViewerActionResources = ReadonlyMap<string, ViewerActionResource>;
export type ViewerActionBinding = Readonly<{
  action: string;
  operationId: string;
  exposure: Exposure;
  authority: 'resource' | 'own-account';
  accountAuthority?: AccountAuthorityKind;
  fixedResourceId?: string;
}>;
export type ViewerActionBindings = ReadonlyMap<string, readonly ViewerActionBinding[]>;

/** Include conditional native anchors in the same per-type/action limit. */
export function viewerActionBindingActions(binding: ViewerActionBinding): readonly string[] {
  return binding.accountAuthority ? ['account:read', 'account:update', 'account:manage'] : [binding.action];
}

/** No module-maintained operation list: only mounted direct declarations and
 * explicit different authority anchors participate in this catalogue. */
export function compileViewerActionBindings(routes: readonly MountedRoute[]): ViewerActionBindings {
  const result = new Map<string, ViewerActionBinding[]>();
  for (const route of routes) {
    const detail = route.hooks?.detail as Record<string, unknown> | undefined;
    if (!detail || detail.hide === true) continue;
    const direct = detail['x-resource-types'];
    const anchor = detail['x-authority-resource-types'];
    const types = anchor ?? direct;
    const authority = detail['x-authority-anchor'] ?? 'resource';
    if (authority !== 'resource' && authority !== 'own-account')
      throw new Error(`${route.method} ${route.path}: invalid x-authority-anchor`);
    if (authority === 'own-account' && anchor === undefined)
      throw new Error(`${route.method} ${route.path}: own-account requires x-authority-resource-types`);
    const fixedResourceId = detail['x-authority-resource-id'];
    if (
      fixedResourceId !== undefined &&
      (fixedResourceId !== PLATFORM_RESOURCE.id ||
        authority !== 'resource' ||
        !Array.isArray(anchor) ||
        anchor.length !== 1 ||
        anchor[0] !== 'semantic.context' ||
        detail['x-account-authority'] !== undefined)
    )
      throw new Error(`${route.method} ${route.path}: invalid x-authority-resource-id`);
    if (types === undefined) continue;
    if (
      !Array.isArray(types) ||
      !types.length ||
      types.some((v) => typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]*(?::[A-Za-z][A-Za-z0-9_.-]*)?$/.test(v)) ||
      new Set(types).size !== types.length
    )
      throw new Error(`${route.method} ${route.path}: invalid x-authority-resource-types`);
    const action = actionLabelOfMountedRoute(route);
    const accountAuthority = detail['x-account-authority'];
    if (
      accountAuthority !== undefined &&
      (!['profile', 'self', 'verification'].includes(String(accountAuthority)) ||
        authority !== 'resource' ||
        types.length !== 1 ||
        types[0] !== 'access.account' ||
        !['account:read', 'account:update'].includes(action) ||
        (accountAuthority === 'profile' && action !== 'account:update'))
    )
      throw new Error(`${route.method} ${route.path}: invalid x-account-authority`);
    if (typeof detail.operationId !== 'string') throw new Error(`${route.method} ${route.path}: missing operationId`);
    for (const type of types as string[]) {
      const bindings = result.get(type) ?? [];
      bindings.push(
        Object.freeze({
          action,
          operationId: detail.operationId,
          exposure: parseExposure(detail),
          authority,
          ...(fixedResourceId === undefined ? {} : { fixedResourceId: fixedResourceId as string }),
          ...(accountAuthority === undefined ? {} : { accountAuthority: accountAuthority as AccountAuthorityKind }),
        }),
      );
      if (bindings.length > 256 || new Set(bindings.flatMap(viewerActionBindingActions)).size > 64)
        throw new Error(`${type}: viewer actions exceed 64 candidate actions or 256 operation bindings`);
      result.set(type, bindings);
    }
  }
  return new Map([...result].map(([type, bindings]) => [type, Object.freeze(bindings)]));
}

const closed = { additionalProperties: false } as const;
const reference = t.Object({ type: t.String({ minLength: 1 }), id: t.String() }, closed);
const input = t.Object({ resources: t.Array(reference, { minItems: 1, maxItems: 100 }) }, closed);
function strict<S extends TSchema>(schema: S) {
  const validator = Compile(schema);
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'typebox',
      types: undefined as { input: Static<S>; output: Static<S> } | undefined,
      validate(value: unknown) {
        return validator.Check(value)
          ? { value: value as Static<S> }
          : { issues: [{ message: 'Invalid viewer actions batch' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}
const viewerAction = t.Object(
  { action: t.String(), operations: t.Array(t.String(), { minItems: 1, uniqueItems: true }) },
  closed,
);
const output = t.Object(
  {
    resources: t.Array(
      t.Union([
        t.Object({ type: t.String(), id: t.String(), viewerActions: t.Array(viewerAction) }, closed),
        t.Object({ type: t.String(), id: t.String(), error: t.Literal('not_found') }, closed),
      ]),
    ),
  },
  closed,
);

type Reference = Static<typeof reference>;
export async function readViewerActions(
  deps: {
    pool: Pool;
    access: Access;
    resources: ViewerActionResources;
    bindings: ViewerActionBindings;
    clock: () => Date;
    work?: AccessWorkAccounting;
  },
  actor: Actor,
  refs: readonly Reference[],
  deadline: number,
) {
  // Complete validation precedes every permission port, including shared preparation.
  if (
    !refs.length ||
    refs.length > 100 ||
    new Set(refs.map(({ type, id }) => `${type}/${id}`)).size !== refs.length ||
    refs.some(({ type, id }) => routeOf(id) === null || !deps.resources.has(type))
  )
    throw new ProblemError('invalid_request');
  const selected = new Map<string, string[]>();
  for (const ref of refs) selected.set(ref.type, [...(selected.get(ref.type) ?? []), ref.id]);
  // Restrict the mounted catalogue before any permission preparation or gate work.
  // A mixed batch still checks each fixed binding only on its actual native id.
  const bindings = new Map(
    [...selected].map(([type, ids]) => [
      type,
      (deps.bindings.get(type) ?? []).filter(
        (binding) => binding.fixedResourceId === undefined || ids.includes(binding.fixedResourceId),
      ),
    ]),
  );
  const typeActions = new Map<string, Set<string>>();
  const admit = (type: string, action: string) => {
    const actions = typeActions.get(type) ?? new Set<string>();
    actions.add(action);
    typeActions.set(type, actions);
  };
  for (const type of selected.keys()) {
    admit(type, deps.resources.get(type)!.readAction);
    for (const binding of bindings.get(type) ?? []) {
      for (const action of viewerActionBindingActions(binding))
        admit(binding.authority === 'own-account' ? 'access.account' : type, action);
    }
  }
  const actions = new Set([...typeActions.values()].flatMap((values) => [...values]));
  let readTime: AuthoritativeTime | undefined;
  try {
    const context = { pool: deps.pool, deadline, ...(deps.work ? { work: deps.work } : {}) };
    const decisions = await prepareReadDecisions(deps.access, { actor, actions, typeActions, context });
    const time = viewerActionReadTime(deps.access, context);
    readTime = time;
    const at = authoritativeTimeValue(time);
    const accountIds = selected.get('access.account');
    const needsAccountAuthority =
      accountIds && (bindings.get('access.account') ?? []).some((binding) => binding.accountAuthority);
    if (needsAccountAuthority && !decisions.prepareAccountAuthority) throw new ProblemError('dependency_unavailable');
    const accountAuthority = needsAccountAuthority ? await decisions.prepareAccountAuthority!(accountIds) : undefined;
    const groups = new Set<string>();
    for (const type of selected.keys())
      for (const binding of bindings.get(type) ?? [])
        if (binding.exposure.kind === 'gate') groups.add(binding.exposure.group);
    const openings = await openGroups.run(deadlineClient(deps.pool, deadline), { groups: [...groups], at });
    const open = new Set(openings.map((row) => row.group));
    const owners = new Map<string, ViewerActionResource>();
    for (const [type, ids] of selected) {
      const owner = deps.resources.get(type)!;
      owners.set(
        type,
        owner.prepare ? await owner.prepare({ pool: deps.pool, access: deps.access, actor, ids, deadline }) : owner,
      );
    }
    return await withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const gates = new Map<string, boolean>();
        for (const type of selected.keys())
          for (const binding of bindings.get(type) ?? []) {
            if (binding.exposure.kind !== 'gate') continue;
            const group = binding.exposure.group;
            for (const action of viewerActionBindingActions(binding)) {
              const key = `${group}/${action}`;
              if (actor.kind !== 'account' || !actor.scopes.includes(action)) continue;
              if (!gates.has(key))
                gates.set(
                  key,
                  open.has(group) ||
                    (await authorizePlatformGate(
                      deps.access,
                      actor,
                      [`gate:${group}`, 'gate:any'],
                      action,
                      GLOBAL_CONTEXT,
                      context,
                      at,
                      client,
                    )),
                );
            }
          }
        const results = new Map<
          string,
          { error: 'not_found' } | { viewerActions: { action: string; operations: string[] }[] }
        >();
        // Own-account decisions are shared across all displayed types and subjects,
        // and are never retained past this request's authoritative instant.
        const ownAllowed = new Map<string, boolean>();
        if (actor.kind === 'account')
          for (const action of new Set(
            [...selected.keys()].flatMap((type) =>
              (bindings.get(type) ?? [])
                .filter((binding) => binding.authority === 'own-account')
                .map((binding) => binding.action),
            ),
          )) {
            const answer = await decisions.decide(
              client,
              {
                action,
                resourceType: 'access.account',
                ids: [actor.accountId],
              },
              time,
            );
            ownAllowed.set(action, answer[actor.accountId]?.allowed === true);
          }
        for (const [type, ids] of selected) {
          const owner = owners.get(type)!;
          const eligibility = await owner.read(client, ids, at, time, deps.work);
          const nativeActions = await owner.actionAvailability?.(client, ids, actor, time);
          const candidates = [
            ...new Set([
              owner.readAction,
              ...(bindings.get(type) ?? [])
                .filter(({ authority, accountAuthority }) => authority === 'resource' && !accountAuthority)
                .map(({ action }) => action),
            ]),
          ].sort();
          const allowed = new Map<string, Readonly<Record<string, { allowed: boolean }>>>();
          for (const action of candidates) {
            const actionIds =
              action === owner.readAction
                ? ids
                : ids.filter((id) =>
                    (bindings.get(type) ?? []).some(
                      (binding) =>
                        binding.authority === 'resource' &&
                        !binding.accountAuthority &&
                        binding.action === action &&
                        (binding.fixedResourceId === undefined || binding.fixedResourceId === id),
                    ),
                  );
            allowed.set(
              action,
              await decisions.decide(
                client,
                {
                  action,
                  resourceType: type,
                  ids: actionIds,
                  ...(action === owner.readAction
                    ? { eligibility: async () => Object.fromEntries(ids.map((id) => [id, eligibility[id] === true])) }
                    : {}),
                },
                time,
              ),
            );
          }
          const nativeAccounts = new Map<string, Awaited<ReturnType<NonNullable<typeof accountAuthority>['decide']>>>();
          for (const binding of bindings.get(type) ?? []) {
            if (!binding.accountAuthority || !accountAuthority) continue;
            const key = `${binding.accountAuthority}/${binding.action}`;
            if (!nativeAccounts.has(key))
              nativeAccounts.set(
                key,
                await accountAuthority.decide(
                  client,
                  {
                    kind: binding.accountAuthority,
                    action: binding.action,
                    ids,
                  },
                  time,
                ),
              );
          }
          for (const id of ids) {
            if (!(id in eligibility) || !allowed.get(owner.readAction)?.[id]?.allowed) {
              results.set(`${type}/${id}`, { error: 'not_found' });
              continue;
            }
            const entries = new Map<string, Set<string>>();
            for (const binding of bindings.get(type) ?? []) {
              if (binding.fixedResourceId !== undefined && binding.fixedResourceId !== id) continue;
              if (nativeActions?.[id]?.[binding.action] === false) continue;
              const native = binding.accountAuthority
                ? nativeAccounts.get(`${binding.accountAuthority}/${binding.action}`)?.[id]
                : undefined;
              const action = native?.action ?? binding.action;
              if (
                !(binding.accountAuthority
                  ? native?.allowed
                  : binding.authority === 'own-account'
                    ? ownAllowed.get(binding.action)
                    : allowed.get(binding.action)?.[id]?.allowed) ||
                (binding.exposure.kind === 'gate' &&
                  !open.has(binding.exposure.group) &&
                  (actor.kind !== 'account' ||
                    !actor.scopes.includes(action) ||
                    !gates.get(`${binding.exposure.group}/${action}`)))
              )
                continue;
              const operations = entries.get(action) ?? new Set<string>();
              operations.add(binding.operationId);
              entries.set(action, operations);
            }
            results.set(`${type}/${id}`, {
              viewerActions: [...entries]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([action, operations]) => ({ action, operations: [...operations].sort() })),
            });
          }
        }
        await client.query('COMMIT');
        return { resources: refs.map((ref) => ({ ...ref, ...results.get(`${ref.type}/${ref.id}`)! })) };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    throw new ProblemError('dependency_unavailable');
  } finally {
    if (readTime) releaseOperationalTime(readTime);
  }
}

export function viewerActionsRoutes(
  app: ReturnType<typeof createApp>,
  deps: {
    pool: Pool;
    access: () => Access;
    resources: ViewerActionResources;
    bindings: () => ViewerActionBindings;
    clock: () => Date;
  },
) {
  return app.post(
    '/v1/viewerActions',
    {
      body: strict(input),
      response: {
        200: output,
        400: problemSchema('invalid_request'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        503: problemSchema('dependency_unavailable'),
      },
      detail: {
        operationId: 'viewer_actions.read',
        'x-action': 'viewer_actions:read',
        'x-exposure': 'public',
        security: [{ bearerAuth: [] }, {}],
      },
    },
    async ({ actor, body, job, set }) => {
      set.headers['cache-control'] = 'private, no-store';
      return readViewerActions(
        { ...deps, access: deps.access(), bindings: deps.bindings() },
        actor,
        body.resources,
        job.deadline,
      );
    },
  );
}
