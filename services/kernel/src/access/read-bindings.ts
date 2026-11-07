import type { Access, AccessClient, AccessContext, Actor, Resource } from '../request/access.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { accessRoot } from './derived-access.ts';
import { AccessUnavailableError } from './unavailable.ts';

type PlatformGateCheck = (
  actor: Actor,
  actions: readonly string[],
  clientAction: string,
  resource: Resource,
  context: AccessContext,
  at: string,
  client?: AccessClient,
) => Promise<boolean>;
export const platformGateChecks = new WeakMap<Access, PlatformGateCheck>();
export const preparedReadTimes = new WeakMap<Access, WeakMap<AccessContext, AuthoritativeTime>>();
/** The native batch's already-observed kernel instant; no second clock query. */
export function viewerActionReadTime(access: Access, context: AccessContext): AuthoritativeTime {
  const time = preparedReadTimes.get(accessRoot(access))?.get(context);
  if (!time) throw new AccessUnavailableError('overloaded');
  return time;
}
/** Evaluate exact gate actions on the Global Context, borrowing the mounted operation's scope operand. */
export function authorizePlatformGate(
  access: Access,
  actor: Actor,
  actions: readonly string[],
  clientAction: string,
  resource: Resource,
  context: AccessContext,
  at: string,
  client?: AccessClient,
): Promise<boolean> {
  return (
    platformGateChecks.get(accessRoot(access))?.(actor, actions, clientAction, resource, context, at, client) ??
    Promise.resolve(false)
  );
}
