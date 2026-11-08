export { PlatformClosedError } from '../contract/index.ts';
import { type AuthoritativeTime } from '../../command/command.ts';
import type { AccessWorkAccounting } from '../work.ts';
import type { Pool } from 'pg';
import type { Access, Actor } from '../../request/access.ts';
import { type MountedRoute } from '../../http/request.ts';
/** Group-level rule shared by route admission and in-process entries: an open
 * group admits everyone, a closed one only an account holding `gate:<group>` or
 * `gate:any` on the Global Context. `clientAction` is the scope operand borrowed
 * for the check. */
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
