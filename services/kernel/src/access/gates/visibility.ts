import { requireAccessDeadline } from '../unavailable.ts';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../authenticate.ts';
import {
  compileExposureCatalogue,
  decideExposure,
  exposureAuthorityActions,
  type ExposureCatalogue,
  type ExposureOperation,
} from '@rezics/access';
import { authorizePlatformGate } from '../index.ts';
import { withConnection } from '../../database/pool.ts';
import { actionLabelOfMountedRoute, type MountedRoute } from '../../http/request.ts';
import type { Access, Actor } from '../../request/access.ts';
import { GLOBAL_CONTEXT } from './catalogue.ts';
import { parseExposure } from './declaration.ts';
import openGroups from './open-groups.sql';

export type VisibleOperation = {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly action: string;
  readonly exposure: 'public' | `gate:${string}`;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mounted contract operations. Hidden routes are omitted, matching the generated document. */
export function classifyExposureRoutes(routes: readonly MountedRoute[]): readonly ExposureOperation[] {
  const operations: ExposureOperation[] = [];
  for (const route of routes) {
    const detail = isRecord(route.hooks?.detail) ? route.hooks.detail : undefined;
    if (detail?.hide === true) continue;
    const exposure = parseExposure(detail);
    const operationId = detail?.operationId;
    if (typeof operationId !== 'string') throw new Error(`${route.method} ${route.path}: routes declare operationId`);
    operations.push(
      Object.freeze({
        method: route.method.toUpperCase(),
        path: route.path,
        operationId,
        action: actionLabelOfMountedRoute(route),
        exposure,
      }),
    );
  }
  return Object.freeze(operations);
}

const deploymentCatalogues = new WeakMap<readonly MountedRoute[], ExposureCatalogue>();

/** Cache only immutable mounted policy facts; opening and authority observations remain request-local. */
export function mountedExposureCatalogue(routes: readonly MountedRoute[]): ExposureCatalogue {
  let catalogue = deploymentCatalogues.get(routes);
  if (!catalogue) {
    catalogue = compileExposureCatalogue(classifyExposureRoutes(routes));
    deploymentCatalogues.set(routes, catalogue);
  }
  return catalogue;
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
async function discover(input: DiscoveryInput): Promise<readonly ExposureOperation[]> {
  const catalogue = mountedExposureCatalogue(input.routes);
  const operations = catalogue.operations;
  const scopedActions = new Map<string, string>();
  for (const operation of operations) {
    if (operation.exposure.kind !== 'gate') continue;
    const group = operation.exposure.group;
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
  if (catalogue.groups.length > 0) {
    await within(input.deadline, () =>
      withConnection(input.pool, async (client) => {
        const bounded = deadlineClient(client, input.deadline);
        for (const row of await openGroups.run(bounded, { groups: [...catalogue.groups], at: instant })) {
          if (typeof row.group !== 'string') throw new Error('Open group read failed');
          open.add(row.group);
        }
      }),
    );
    for (const [group, action] of scopedActions) {
      if (open.has(group)) continue;
      const gateAuthority = await authorizePlatformGate(
        input.access,
        input.viewer,
        exposureAuthorityActions(group),
        action,
        GLOBAL_CONTEXT,
        { pool: input.pool, deadline: input.deadline },
        instant,
      );
      if (
        decideExposure({
          exposure: { kind: 'gate', group },
          open: false,
          actor: 'account',
          clientScope: true,
          gateAuthority,
        }).allowed
      ) {
        held.add(group);
      }
    }
  }
  return operations.filter((operation) => {
    const group = operation.exposure.kind === 'gate' ? operation.exposure.group : undefined;
    return decideExposure({
      exposure: operation.exposure,
      open: group !== undefined && open.has(group),
      actor: input.viewer.kind,
      clientScope: input.viewer.kind === 'account' && input.viewer.scopes.includes(operation.action),
      gateAuthority: group !== undefined && held.has(group),
    }).allowed;
  });
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
