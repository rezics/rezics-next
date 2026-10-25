import type { Pool } from 'pg';
import type { AuthorizationAnchor } from './resource-authorization.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, AccessClient, AccessContext, AccountActor } from '../request/access.ts';

/** sourceId is the immutable actual native workflow/source binding, never new
 * authority supplied by a caller.
 */
export type DurableOperationAnchor = Readonly<{ route: number; id: string; kind: string; sourceId: string }>;

/** Committed allowlisted snapshot only. All fields, including the actor and its
 * captured scope ceiling, must remain immutable. No bearer, refresh token,
 * session cookie or private account profile belongs in this record.
 */
export type DurableInitiatorRecord = Readonly<{
  operation: DurableOperationAnchor;
  initiatorAccountId: string;
  actor: AccountActor;
  recordedTransactionId: string;
}>;

/** Trusted server composition over the owning module's real immutable row,
 * never supplied by request or DBOS data. The reader queries exact route/id,
 * checks kind/source/initiator/transaction, verifies module-specific committed
 * command provenance and immutable source binding, and returns only committed
 * allowlisted fields. Domain SQL stays module-owned. A permission callback,
 * raw caller actor, unverified shape or fixture Map cannot supply authority.
 */
export type DurableInitiatorReader = (
  client: AccessClient,
  operation: DurableOperationAnchor,
  time: AuthoritativeTime,
) => Promise<DurableInitiatorRecord | null>;

export type InitiatorRestoreInput = Readonly<{
  operation: DurableOperationAnchor;
  action: string;
  /** Validates the actual step authority resource, beyond operation existence. */
  anchor: AuthorizationAnchor;
  /** Same pool as installed, finite deadline, no target transaction held. */
  context: AccessContext;
}>;

export type InitiatorRestorerConfig = Readonly<{
  pool: Pool;
  access: Access;
  readOperation: DurableInitiatorReader;
}>;

export type InitiatorRestorer = Readonly<{
  restoreInitiator(operation: InitiatorRestoreInput, time: AuthoritativeTime): Promise<AccountActor>;
}>;

export class DurableInitiatorUnavailableError extends Error {
  constructor() {
    super('Durable initiator restoration is unavailable');
    this.name = 'DurableInitiatorUnavailableError';
  }
}

/** Contract-only fail-closed stub: O(1) time/memory, zero SQL or partitions.
 * Neither factory nor method inspects caller data or invokes any dependency.
 *
 * Native restoration must run inside CommandAuthorization.prepare using live
 * runCommand CommandAttempt.time, before target partition checkout. Never use
 * a fabricated Date/header or a command body holding a connection. Durable
 * snapshot attribution cannot authorize: the restored genuine actor must serve
 * the SAME formula/body. Evaluate action/anchor at that same T and preserve
 * authorization before receipt lookup. Replay and every retry restore anew;
 * never cache a DBOS authorization step or use a detached stale result. Extra
 * exact per-target body/step checks use the native formula at that same T.
 *
 * The later native implementation owes exact native committed provenance,
 * current account/fence/operator/authn floor, current client-consent ceiling,
 * delegation and all three formula operands, limited to the original scopes.
 * Identity admission requires a private instance/pool-bound authenticator
 * bridge, never public registerActor(JSON). Original bearer expiry alone must
 * not prevent an otherwise authorized durable operation; this contract adds
 * no expiry policy, generic 300s approval or approval bypass/expiry weakening.
 * Cleanup after self-authority removal remains separate native exceptions.
 * No Auth DB, credentials or runtime belongs in kernel.
 *
 * Native cost proof remains due: exact operation/home row, current account/fence,
 * client-consent witness at its own home, delegation and bounded K <= 1000
 * formula, independent of operation/history count. This stub proves none of it.
 */
export function createInitiatorRestorer(_config: InitiatorRestorerConfig): InitiatorRestorer {
  return Object.freeze<InitiatorRestorer>({
    async restoreInitiator(_operation, _time) {
      throw new DurableInitiatorUnavailableError();
    },
  });
}
