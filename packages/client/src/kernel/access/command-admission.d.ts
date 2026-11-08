import { type CommandAttempt } from '../command/command.ts';
import { type KernelClock } from '../clock.ts';
import { type IdentityExpiry } from './identity-expiry.ts';
import { type Access, type AccessContext, type AccountActor, type Actor } from './check.ts';
import { type Account } from './account-data.ts';
export declare function commandAccessContext(context: AccessContext, attempt: CommandAttempt): AccessContext;
export declare function accessCommandAttempt(context: AccessContext): CommandAttempt | undefined;
type Snapshot = Readonly<{
    expiryClock?: IdentityExpiry['expiryClock'];
    expires: number;
    account: Account;
    pool: AccessContext['pool'];
    deadline: number;
    durableTime?: import('../command/command.ts').AuthoritativeTime;
}>;
type CapturedAccount = Readonly<{
    minimumAuthnEpoch: string;
    operatorAccountId: string | null;
}>;
/** Internal capture port: consumes only a successful observation of this actor at this live T. */
export declare function admittedCommandAccount(context: AccessContext, actor: AccountActor): CapturedAccount | null;
type Admission = (actor: Actor, context: AccessContext) => Promise<Account | null>;
export declare function installCommandAdmission(access: Access, admission: Admission): void;
/** Operator's additional domain prerequisites consume this same observation.
 * Test Access adapters without an installed authenticator retain their native
 * account observation; production uses the instance/pool-bound admission hook.
 */
export declare function actingCommandAccount(access: Access, actor: AccountActor, context: AccessContext): Promise<Account | null>;
/** A missing registration refuses the command. An installed admission still
 * checks only account actors; anonymous attempts add no actor read.
 */
export declare function requireCommandAdmission(access: Access, actor: Actor, context: AccessContext): Promise<void>;
/** One independently anchored point observation per actor/live attempt. Never
 * replace the authenticated snapshot: even a changed floor below token epoch
 * revokes that snapshot. All action preparations share only this opaque result.
 */
export declare function createCommandAdmission(identity: (actor: AccountActor) => Snapshot | undefined, clock?: KernelClock): Admission;
export {};
