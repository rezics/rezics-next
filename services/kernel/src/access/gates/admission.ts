import type { Pool } from 'pg';
import { authorizePlatformGate } from '../index.ts';
import type { Access, Actor } from '../../request/access.ts';
import { actionLabelOfMountedRoute, type MountedRoute } from '../../http/request.ts';
import { GLOBAL_CONTEXT, readExposure } from './catalogue.ts';
import { parseExposure } from './declaration.ts';

export class PlatformClosedError extends Error {
  constructor() {
    super('Platform operation is closed');
    this.name = 'PlatformClosedError';
  }
}

export async function admitExposure(input: {
  pool: Pool;
  access: Access;
  actor: Actor;
  route: MountedRoute | undefined;
  deadline: number;
  clock: () => Date;
}): Promise<void> {
  const { route } = input;
  if (!route) return;
  const detail = route.hooks?.detail as Record<string, unknown> | undefined;
  if (detail?.hide === true) return;
  const exposure = parseExposure(detail);
  if (exposure.kind === 'public') return;

  const state = await readExposure(input.pool, exposure.group, input.clock(), input.deadline);
  if (state.open) return;
  if (input.actor.kind !== 'account') throw new PlatformClosedError();

  const allowed = await authorizePlatformGate(
    input.access,
    input.actor,
    [`gate:${exposure.group}`, 'gate:any'],
    actionLabelOfMountedRoute(route),
    GLOBAL_CONTEXT,
    { pool: input.pool, deadline: input.deadline },
    state.at,
  );
  if (!allowed) throw new PlatformClosedError();
}
