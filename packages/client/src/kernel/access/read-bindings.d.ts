import type { Access, AccessClient, AccessContext, Actor, Resource } from '../request/access.ts';
import type { AuthoritativeTime } from '../command/command.ts';
type PlatformGateCheck = (actor: Actor, actions: readonly string[], clientAction: string, resource: Resource, context: AccessContext, at: string, client?: AccessClient) => Promise<boolean>;
export declare const platformGateChecks: WeakMap<Access, PlatformGateCheck>;
export declare const preparedReadTimes: WeakMap<Access, WeakMap<AccessContext, AuthoritativeTime>>;
/** The native batch's already-observed kernel instant; no second clock query. */
export declare function viewerActionReadTime(access: Access, context: AccessContext): AuthoritativeTime;
/** Evaluate exact gate actions on the Global Context, borrowing the mounted operation's scope operand. */
export declare function authorizePlatformGate(access: Access, actor: Actor, actions: readonly string[], clientAction: string, resource: Resource, context: AccessContext, at: string, client?: AccessClient): Promise<boolean>;
export {};
