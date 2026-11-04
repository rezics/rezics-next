import { readNativeAccessTime } from '../authenticate.ts';
import { authoritativeTimeValue, releaseOperationalTime, type AuthoritativeTime } from '../../command/command.ts';
import type { AccessWorkAccounting } from '../work.ts';
import type { Pool } from 'pg';
import { decideExposure, exposureAuthorityActions } from '@rezics/access';
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
  work?: AccessWorkAccounting;
  time?: AuthoritativeTime;
}): Promise<void> {
  let ownedTime: AuthoritativeTime | undefined;
  try {
    const time = input.work ? (input.time ?? (ownedTime = await readNativeAccessTime(input, input.clock))) : undefined;
    const at = time ? new Date(authoritativeTimeValue(time)) : input.clock();
    const state = await readExposure(input.pool, input.group, at, input.deadline, input.work, time);
    const clientScope = input.actor.kind === 'account' && input.actor.scopes.includes(input.clientAction);
    const gateAuthority =
      !state.open && input.actor.kind === 'account' && clientScope
        ? await authorizePlatformGate(
            input.access(),
            input.actor,
            exposureAuthorityActions(input.group),
            input.clientAction,
            GLOBAL_CONTEXT,
            {
              pool: input.pool,
              deadline: input.deadline,
              ...(input.work ? { work: input.work } : {}),
              ...(time ? { time } : {}),
            },
            state.at,
          )
        : false;
    if (
      !decideExposure({
        exposure: { kind: 'gate', group: input.group },
        open: state.open,
        actor: input.actor.kind,
        clientScope,
        gateAuthority,
      }).allowed
    )
      throw new PlatformClosedError();
  } catch (error) {
    // An ordinary closed decision keeps its successful receipt usable.
    if (!(error instanceof PlatformClosedError)) input.work?.fail(error);
    throw error;
  } finally {
    if (ownedTime) releaseOperationalTime(ownedTime);
  }
}

export async function admitExposure(input: {
  pool: Pool;
  /** Resolved only when a closed gate needs an account decision. */
  access: () => Access;
  actor: Actor;
  route: MountedRoute | undefined;
  deadline: number;
  clock: () => Date;
  work?: AccessWorkAccounting;
  time?: AuthoritativeTime;
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
    ...(input.work ? { work: input.work } : {}),
    ...(input.time ? { time: input.time } : {}),
  });
}
