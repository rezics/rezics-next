import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../../command/command.ts';
import { withConnection } from '../../database/pool.ts';
import { ProblemError } from '../../http/problem.ts';
import type { MountedRoute } from '../../http/request.ts';
import { accessCheck, AuthenticationError, type Access, type Actor } from '../../request/access.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../../tokens/list-cursor.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import { deadlineClient, within } from '../authenticate.ts';
import { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable } from '../unavailable.ts';
import { GLOBAL_CONTEXT, readExposure } from './catalogue.ts';
import { classifyExposureRoutes } from './visibility.ts';

export type ExposureManagementDependencies = {
  pool: Pool;
  access: Access;
  clock?: () => Date;
  cursorKeys: KeyRing;
  routes: readonly MountedRoute[];
};
export type ExposureManagementPage = {
  viewer: { accountId: string; clientId: string };
  actions: { open: boolean; close: boolean };
  exposureGroups: { group: string; open: boolean; at: string }[];
  next: string | null;
};

type ExposureAction = keyof ExposureManagementPage['actions'];
type Catalogue = Readonly<{
  groups: readonly string[];
  digest: string;
  actions: Readonly<Record<ExposureAction, boolean>>;
}>;
const catalogues = new WeakMap<readonly MountedRoute[], Catalogue>();

function isInstalledCommand(routes: readonly MountedRoute[], action: ExposureAction): boolean {
  return routes.some((route) => {
    const detail = route.hooks?.detail;
    if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return false;
    const metadata = detail as Record<string, unknown>;
    const types = metadata['x-authority-resource-types'];
    return (
      metadata.hide !== true &&
      route.method.toUpperCase() === 'POST' &&
      route.path === `/v1/platform/exposure/:group/$${action}` &&
      metadata.operationId === `exposure.${action}` &&
      metadata['x-action'] === `exposure:${action}` &&
      metadata['x-exposure'] === 'public' &&
      Array.isArray(types) &&
      types.length === 1 &&
      types[0] === 'semantic.context' &&
      metadata['x-authority-resource-id'] === GLOBAL_CONTEXT.id &&
      (metadata['x-authority-anchor'] === undefined || metadata['x-authority-anchor'] === 'resource') &&
      metadata['x-account-authority'] === undefined
    );
  });
}

/** Only deployment metadata is retained. Current openings and authority are always read anew. */
function catalogueOf(routes: readonly MountedRoute[]): Catalogue {
  let catalogue = catalogues.get(routes);
  if (catalogue) return catalogue;
  const operations = classifyExposureRoutes(routes);
  const groups = Object.freeze(
    [...new Set(operations.flatMap((op) => (op.exposure.kind === 'gate' ? [op.exposure.group] : [])))].sort(),
  );
  const declarations = operations
    .map((op) => JSON.stringify([op.method, op.path, op.operationId, op.action, op.exposure]))
    .sort();
  const actions = Object.freeze({
    open: isInstalledCommand(routes, 'open'),
    close: isInstalledCommand(routes, 'close'),
  });
  catalogue = Object.freeze({
    groups,
    actions,
    digest: createHash('sha256')
      .update(JSON.stringify([declarations, actions]))
      .digest('hex'),
  });
  catalogues.set(routes, catalogue);
  return catalogue;
}

/** Binary keyset lookup over the immutable installed catalogue, with no per-request route projection. */
function position(groups: readonly string[], after: string): number {
  let lo = 0;
  let hi = groups.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (groups[mid]! <= after) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0 || groups[lo - 1] !== after) throw new ProblemError('invalid_cursor');
  return lo;
}

/** Exact current Global authority, rather than viewer admission or an inferred public opening. */
export async function readExposureManagementPage(
  dependencies: ExposureManagementDependencies,
  actor: Actor,
  query: { cursor?: string; limit?: number },
  { deadline }: { deadline: number },
): Promise<ExposureManagementPage> {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  const catalogue = catalogueOf(dependencies.routes);
  try {
    requireAccessDeadline(deadline);
    const time = await within(deadline, () =>
      withConnection(dependencies.pool, (client) => mintReadTime(deadlineClient(client, deadline), dependencies.clock)),
    );
    try {
      const at = new Date(authoritativeTimeValue(time));
      const context = { pool: dependencies.pool, deadline, time };
      async function requireAuthority() {
        // Fresh native preparation on both sides of the configuration read refreshes actor/principal evidence.
        const check = await accessCheck(dependencies.access, actor, 'exposure:manage_read', GLOBAL_CONTEXT, context);
        const allowed = await within(deadline, () =>
          withConnection(dependencies.pool, (client) => check(deadlineClient(client, deadline), time)),
        );
        requireAccessDeadline(deadline);
        if (!allowed) throw new ProblemError('forbidden');
      }

      async function actionAdvice(): Promise<ExposureManagementPage['actions']> {
        const advice: ExposureManagementPage['actions'] = { open: false, close: false };
        for (const action of ['open', 'close'] as const) {
          if (!catalogue.actions[action]) continue;
          const check = await accessCheck(dependencies.access, actor, `exposure:${action}`, GLOBAL_CONTEXT, context);
          advice[action] = await within(deadline, () =>
            withConnection(dependencies.pool, (client) => check(deadlineClient(client, deadline), time)),
          );
          requireAccessDeadline(deadline);
        }
        return advice;
      }

      await requireAuthority();
      const binding: ListCursorBinding = {
        route: 'GET /v1/platform/exposure/management',
        viewer: actor.accountId,
        query: {
          limit,
          catalogue: catalogue.digest,
          credential: createHash('sha256')
            .update(JSON.stringify([actor.clientId, actor.requestedBy, actor.authnEpoch, [...actor.scopes].sort()]))
            .digest('hex'),
        },
      };
      let start = 0;
      if (query.cursor !== undefined) {
        const decoded = await decodeListCursor(dependencies.cursorKeys, binding, query.cursor, at);
        if (!decoded.ok || decoded.epoch !== 1 || decoded.after.length !== 1 || typeof decoded.after[0] !== 'string')
          throw new ProblemError('invalid_cursor');
        start = position(catalogue.groups, decoded.after[0]);
      }
      const actionsBefore = await actionAdvice();
      const selected = catalogue.groups.slice(start, start + limit);
      const exposureGroups: ExposureManagementPage['exposureGroups'] = [];
      for (const group of selected) {
        const state = await readExposure(dependencies.pool, group, time, deadline);
        exposureGroups.push({ group, ...state });
      }
      const next =
        start + selected.length < catalogue.groups.length
          ? await encodeListCursor(dependencies.cursorKeys, binding, { epoch: 1, after: [selected.at(-1)!] }, at)
          : null;
      const actionsAfter = await actionAdvice();
      await requireAuthority();
      return {
        viewer: { accountId: actor.accountId, clientId: actor.clientId },
        actions: {
          open: actionsBefore.open && actionsAfter.open,
          close: actionsBefore.close && actionsAfter.close,
        },
        exposureGroups,
        next,
      };
    } finally {
      releaseOperationalTime(time);
    }
  } catch (error) {
    if (error instanceof ProblemError || error instanceof CommandUnavailableError) throw error;
    throwAccessUnavailable(error, deadline);
    throw new ProblemError('dependency_unavailable');
  }
}
