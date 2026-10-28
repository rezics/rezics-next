import { requireAccessDeadline } from '../unavailable.ts';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../authenticate.ts';
import { authorizePlatformGate } from '../index.ts';
import { withConnection } from '../../database/pool.ts';
import { actionLabelOfMountedRoute, type MountedRoute } from '../../http/request.ts';
import type { Access, Actor } from '../../request/access.ts';
import { GLOBAL_CONTEXT } from './catalogue.ts';
import { parseExposure, type Exposure } from './declaration.ts';
import openGroups from './open-groups.sql';

export type VisibleOperation = {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly action: string;
  readonly exposure: 'public' | `gate:${string}`;
};

type Classified = {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly action: string;
  readonly exposure: Exposure;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mounted contract operations. Hidden routes are omitted, matching the generated document. */
function classify(routes: readonly MountedRoute[]): Classified[] {
  const operations: Classified[] = [];
  for (const route of routes) {
    const detail = isRecord(route.hooks?.detail) ? route.hooks.detail : undefined;
    if (detail?.hide === true) continue;
    const exposure = parseExposure(detail);
    const operationId = detail?.operationId;
    if (typeof operationId !== 'string') throw new Error(`${route.method} ${route.path}: routes declare operationId`);
    operations.push({
      method: route.method.toUpperCase(),
      path: route.path,
      operationId,
      action: actionLabelOfMountedRoute(route),
      exposure,
    });
  }
  return operations;
}

type DiscoveryInput = {
  viewer: Actor;
  pool: Pool;
  access: Access;
  routes: readonly MountedRoute[];
  deadline: number;
  clock: () => Date;
};

/** Read openings and ask admission's formula once per closed group with an in-scope operation. */
async function discover(input: DiscoveryInput): Promise<Classified[]> {
  const operations = classify(input.routes);
  const groups = new Set<string>();
  const scopedActions = new Map<string, string>();
  for (const operation of operations) {
    if (operation.exposure.kind !== 'gate') continue;
    const group = operation.exposure.group;
    groups.add(group);
    if (input.viewer.kind === 'account' && input.viewer.scopes.includes(operation.action)) {
      if (!scopedActions.has(group)) scopedActions.set(group, operation.action);
    }
  }
  const at = input.clock();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new TypeError('Invalid command clock');
  const instant = at.toISOString();
  const open = new Set<string>();
  const held = new Set<string>();
  requireAccessDeadline(input.deadline);
  if (groups.size > 0) {
    await within(input.deadline, () =>
      withConnection(input.pool, async (client) => {
        const bounded = deadlineClient(client, input.deadline);
        for (const row of await openGroups.run(bounded, { groups: [...groups], at: instant })) {
          if (typeof row.group !== 'string') throw new Error('Open group read failed');
          open.add(row.group);
        }
      }),
    );
    for (const [group, action] of scopedActions) {
      if (open.has(group)) continue;
      if (
        await authorizePlatformGate(
          input.access,
          input.viewer,
          [`gate:${group}`, 'gate:any'],
          action,
          GLOBAL_CONTEXT,
          { pool: input.pool, deadline: input.deadline },
          instant,
        )
      ) {
        held.add(group);
      }
    }
  }
  return operations.filter(
    (operation) =>
      operation.exposure.kind === 'public' ||
      open.has(operation.exposure.group) ||
      (input.viewer.kind === 'account' &&
        input.viewer.scopes.includes(operation.action) &&
        held.has(operation.exposure.group)),
  );
}

/** Mounted groups that are open or have at least one visible operation for this viewer. */
export async function admittedGroups(input: DiscoveryInput): Promise<readonly string[]> {
  const visible = await discover(input);
  return [
    ...new Set(visible.flatMap((operation) => (operation.exposure.kind === 'gate' ? [operation.exposure.group] : []))),
  ].sort();
}

/** The mounted operations this viewer may use at the kernel clock. */
export async function visibleOperations(input: DiscoveryInput): Promise<readonly VisibleOperation[]> {
  return (await discover(input)).map((operation) => ({
    method: operation.method,
    path: operation.path,
    operationId: operation.operationId,
    action: operation.action,
    exposure: operation.exposure.kind === 'public' ? 'public' : `gate:${operation.exposure.group}`,
  }));
}
