import { authoritativeTimeValue, type CommandAttempt } from '../command/command.ts';
import type { Access, AccessContext, AccountActor, Actor } from '../request/access.ts';
import { readAccount, type Account } from './account-data.ts';
import { deadlineClient, within } from './authenticate.ts';

/** A marker is held only in this registry and always carries a live executor time.
 * Request JSON, copied contexts and booleans cannot mark a read as a command.
 */
const contexts = new WeakMap<AccessContext, CommandAttempt>();
export function commandAccessContext(context: AccessContext, attempt: CommandAttempt): AccessContext {
  authoritativeTimeValue(attempt.time);
  const bound = { ...context };
  contexts.set(bound, attempt);
  return bound;
}
export function accessCommandAttempt(context: AccessContext): CommandAttempt | undefined {
  const attempt = contexts.get(context);
  if (attempt) authoritativeTimeValue(attempt.time);
  return attempt;
}

type Snapshot = Readonly<{
  account: Account;
  pool: AccessContext['pool'];
  deadline: number;
  expires: number;
  durableTime?: import('../command/command.ts').AuthoritativeTime;
}>;
type CapturedAccount = Readonly<{ minimumAuthnEpoch: string; operatorAccountId: string | null }>;
const admitted = new WeakMap<
  object,
  WeakMap<AccountActor, { pool: AccessContext['pool']; deadline: number; account: CapturedAccount }>
>();

/** Internal capture port: consumes only a successful observation of this actor at this live T. */
export function admittedCommandAccount(context: AccessContext, actor: AccountActor): CapturedAccount | null {
  const attempt = accessCommandAttempt(context);
  const observation = attempt && admitted.get(attempt.time)?.get(actor);
  return observation &&
    observation.pool === context.pool &&
    Number.isFinite(context.deadline) &&
    Date.now() < Math.min(context.deadline, observation.deadline) &&
    attempt?.basis?.actorAccountId === actor.accountId &&
    attempt.basis.clientId === actor.clientId &&
    attempt.basis.requestedBy === actor.requestedBy
    ? observation.account
    : null;
}

type Admission = (actor: Actor, context: AccessContext) => Promise<Account | null>;
const admissions = new WeakMap<Access, Admission>();
export function installCommandAdmission(access: Access, admission: Admission): void {
  if (admissions.has(access)) throw new Error('Command admission already installed');
  admissions.set(access, admission);
}

/** Operator's additional domain prerequisites consume this same observation.
 * Test Access adapters without an installed authenticator retain their native
 * account observation; production uses the instance/pool-bound admission hook.
 */
export async function actingCommandAccount(
  access: Access,
  actor: AccountActor,
  context: AccessContext,
): Promise<Account | null> {
  if (!accessCommandAttempt(context)) throw new TypeError('Command admission requires a live attempt');
  const admission = admissions.get(access);
  return admission
    ? admission(actor, context)
    : readAccount(
        deadlineClient(context.pool, context.deadline),
        Number.parseInt(actor.accountId.slice(24, 28), 16),
        actor.accountId,
      );
}
export async function requireCommandAdmission(access: Access, actor: Actor, context: AccessContext): Promise<void> {
  if (!accessCommandAttempt(context)) throw new TypeError('Command admission requires a live attempt');
  const admission = admissions.get(access);
  if (admission && actor.kind === 'account' && !(await admission(actor, context)))
    throw new Error('Command admission denied');
}

/** One independently anchored point observation per actor/live attempt. Never
 * replace the authenticated snapshot: even a changed floor below token epoch
 * revokes that snapshot. All action preparations share only this opaque result.
 */
export function createCommandAdmission(identity: (actor: AccountActor) => Snapshot | undefined): Admission {
  const observations = new WeakMap<
    object,
    WeakMap<AccountActor, { deadline: number; account: Promise<Account | null> }>
  >();
  return async (actor, context) => {
    const attempt = accessCommandAttempt(context);
    if (!attempt || actor.kind !== 'account') return null;
    admitted.get(attempt.time)?.delete(actor);
    const snapshot = identity(actor);
    const deadline = Math.min(context.deadline, snapshot?.deadline ?? -Infinity, snapshot?.expires ?? -Infinity);
    if (
      !snapshot ||
      snapshot.pool !== context.pool ||
      (snapshot.durableTime !== undefined && snapshot.durableTime !== attempt.time) ||
      Date.now() >= deadline ||
      !Number.isFinite(deadline) ||
      attempt.basis?.actorAccountId !== actor.accountId ||
      attempt.basis.clientId !== actor.clientId ||
      attempt.basis.requestedBy !== actor.requestedBy
    )
      return null;
    // Restoration already made this independently anchored observation at the
    // same live step T, comparing the immutable creation floor/operator snapshot.
    const remember = (account: Account | null): Account | null => {
      authoritativeTimeValue(attempt.time);
      if (!account || Date.now() >= deadline) return null;
      let actors = admitted.get(attempt.time);
      if (!actors) {
        actors = new WeakMap();
        admitted.set(attempt.time, actors);
      }
      actors.set(actor, {
        pool: context.pool,
        deadline,
        account: Object.freeze({
          minimumAuthnEpoch: account.minimumAuthnEpoch.toString(),
          operatorAccountId: account.operatorAccountId,
        }),
      });
      return account;
    };
    if (snapshot.durableTime === attempt.time) return remember(snapshot.account);
    let actors = observations.get(attempt.time);
    if (!actors) {
      actors = new WeakMap();
      observations.set(attempt.time, actors);
    }
    let observation = actors.get(actor);
    if (!observation) {
      const account = within(deadline, async () => {
        const original = snapshot.account;
        const current = await readAccount(deadlineClient(context.pool, deadline), original.route, actor.accountId);
        return current &&
          current.accountId === original.accountId &&
          current.route === original.route &&
          current.kind === original.kind &&
          current.state === original.state &&
          current.fenced === original.fenced &&
          current.minimumAuthnEpoch === original.minimumAuthnEpoch &&
          current.operatorAccountId === original.operatorAccountId
          ? original
          : null;
      }).catch(() => null);
      observation = { deadline, account };
      actors.set(actor, observation);
    }
    const account = await observation.account;
    authoritativeTimeValue(attempt.time);
    return remember(Date.now() < observation.deadline ? account : null);
  };
}
