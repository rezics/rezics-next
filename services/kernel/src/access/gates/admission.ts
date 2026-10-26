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

/** Group-level rule shared by route admission and in-process entries: an open
 * group admits everyone, a closed one only an account holding `gate:<group>` or
 * `gate:any` on the Global Context. `clientAction` is the scope operand borrowed
 * for the check. */
export async function admitGroup(input: {
  pool: Pool;
  /** Resolved only when a closed gate needs an account decision. */
  access: () => Access;
  actor: Actor;
  group: string;
  clientAction: string;
  deadline: number;
  clock: () => Date;
}): Promise<void> {
  const state = await readExposure(input.pool, input.group, input.clock(), input.deadline);
  if (state.open) return;
  if (input.actor.kind !== 'account') throw new PlatformClosedError();

  const allowed = await authorizePlatformGate(
    input.access(),
    input.actor,
    [`gate:${input.group}`, 'gate:any'],
    input.clientAction,
    GLOBAL_CONTEXT,
    { pool: input.pool, deadline: input.deadline },
    state.at,
  );
  if (!allowed) throw new PlatformClosedError();
}

export async function admitExposure(input: {
  pool: Pool;
  /** Resolved only when a closed gate needs an account decision. */
  access: () => Access;
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

  await admitGroup({
    pool: input.pool,
    access: input.access,
    actor: input.actor,
    group: exposure.group,
    clientAction: actionLabelOfMountedRoute(route),
    deadline: input.deadline,
    clock: input.clock,
  });
}
