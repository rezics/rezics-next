import { requireAccessDeadline } from '../unavailable.ts';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../authenticate.ts';
import { resourceRoleCatalogue } from '../resource-roles.ts';
import { withConnection } from '../../database/pool.ts';
import { actionLabelOfMountedRoute, type MountedRoute } from '../../http/request.ts';
import type { Access, Actor } from '../../request/access.ts';
import { GLOBAL_CONTEXT } from './catalogue.ts';
import { parseExposure, type Exposure } from './declaration.ts';
import heldGates from './held-gates.sql';
import openGroups from './open-groups.sql';

const REQUESTED_BY =
  /^urn:rezics:request:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

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

function principalId(viewer: Actor): string | null {
  if (viewer.kind !== 'account' || viewer.requestedBy === null) return null;
  return REQUESTED_BY.exec(viewer.requestedBy)?.[1] ?? null;
}

function grantRoles(access: Access, action: string): string[] {
  const catalogue = resourceRoleCatalogue(access);
  if (!catalogue) return [];
  return [...catalogue.roles].filter(([, values]) => values.includes(action)).map(([role]) => role);
}

/**
 * The admission decision: a public route, a group open at T, or a closed group whose
 * gate:<group> or gate:any the actor and principal both hold on the Global Context.
 */
function admits(exposure: Exposure, open: ReadonlySet<string>, held: ReadonlySet<string>, viewer: Actor): boolean {
  if (exposure.kind === 'public') return true;
  if (open.has(exposure.group)) return true;
  if (viewer.kind !== 'account' || (viewer.requestedBy !== null && principalId(viewer) === null)) return false;
  return held.has(`gate:${exposure.group}`) || held.has('gate:any');
}

type DiscoveryInput = {
  viewer: Actor;
  pool: Pool;
  access: Access;
  routes: readonly MountedRoute[];
  deadline: number;
  clock: () => Date;
};

/** Mounted gate groups admitted by the same snapshot and rule as operation discovery. */
export async function admittedGroups(input: DiscoveryInput): Promise<readonly string[]> {
  const mounted = new Set<string>();
  for (const route of input.routes) {
    const detail = isRecord(route.hooks?.detail) ? route.hooks.detail : undefined;
    if (detail?.hide === true) continue;
    const exposure = parseExposure(detail);
    if (exposure.kind === 'gate') mounted.add(exposure.group);
  }
  const groups = [...mounted];
  const at = input.clock();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new TypeError('Invalid command clock');
  const open = new Set<string>();
  const held = new Set<string>();
  requireAccessDeadline(input.deadline);
  if (groups.length > 0) {
    const instant = at.toISOString();
    const actions = [...groups.map((group) => `gate:${group}`), 'gate:any'];
    const account = input.viewer.kind === 'account' ? input.viewer : undefined;
    const principal = principalId(input.viewer);
    await within(input.deadline, () =>
      withConnection(input.pool, async (client) => {
        const bounded = deadlineClient(client, input.deadline);
        await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          for (const row of await openGroups.run(bounded, { groups, at: instant })) {
            if (typeof row.group !== 'string') throw new Error('Open group read failed');
            open.add(row.group);
          }
          // An unparsable requested-by URN cannot hold a principal operand, so the grant read is skipped.
          if (account && (account.requestedBy === null || principal !== null)) {
            for (const row of await heldGates.run(bounded, {
              at: instant,
              actor_id: account.accountId,
              principal_id: principal ?? '',
              resource_id: GLOBAL_CONTEXT.id,
              actions: actions.map((action) => ({
                action,
                grant_roles: grantRoles(input.access, action),
              })),
            })) {
              if (typeof row.action !== 'string') throw new Error('Held gate read failed');
              held.add(row.action);
            }
          }
          await bounded.query('COMMIT');
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Preserve the original discovery failure.
          }
          throw error;
        }
      }),
    );
  }
  return groups.filter((group) => admits({ kind: 'gate', group }, open, held, input.viewer)).sort();
}

/** The mounted operations this viewer may use at the kernel clock. */
export async function visibleOperations(input: DiscoveryInput): Promise<readonly VisibleOperation[]> {
  const operations = classify(input.routes);
  const admitted = new Set(await admittedGroups(input));
  return operations
    .filter((operation) => operation.exposure.kind === 'public' || admitted.has(operation.exposure.group))
    .map((operation) => ({
      method: operation.method,
      path: operation.path,
      operationId: operation.operationId,
      action: operation.action,
      exposure: operation.exposure.kind === 'public' ? 'public' : `gate:${operation.exposure.group}`,
    }));
}
