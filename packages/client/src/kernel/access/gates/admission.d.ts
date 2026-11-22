export { PlatformClosedError } from '../contract/index.ts';
import { type AuthoritativeTime } from '../../command/command.ts';
import type { AccessWorkAccounting } from '../work.ts';
import type { Pool } from 'pg';
import type { Access, AccessClient, AccessContext, Actor } from '../../request/access.ts';
import { type MountedRoute } from '../../http/request.ts';
/** Use the same native per-account gate proof for request and operation discovery. */
export declare function authorizeExposureGroup(input: {
    access: Access;
    actor: Actor;
    group: string;
    clientAction: string;
    context: AccessContext;
    at: string;
    client?: AccessClient;
}): Promise<boolean>;
/** Group-level rule shared by route admission and in-process entries: an open
 * group admits everyone, a closed one only an account holding `gate:<group>` or
 * `gate:any` on the Global Context. Private groups require their exact grant.
 * `clientAction` is the scope operand borrowed for the check. */
export declare function admitGroup(input: {
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
}): Promise<void>;
export declare function admitExposure(input: {
    pool: Pool;
    /** Resolved only when a closed gate needs an account decision. */
    access: () => Access;
    actor: Actor;
    route: MountedRoute | undefined;
    deadline: number;
    clock: () => Date;
    work?: AccessWorkAccounting;
    time?: AuthoritativeTime;
}): Promise<void>;
