import { throwAccessUnavailable } from './unavailable.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { authoritativeTimeValue } from '../command/command.ts';
import type { AccessContext, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { accessCommandAttempt, admittedCommandAccount } from './command-admission.ts';
import { deadlineClient, within } from './deadline.ts';
import type { DurableInitiatorRecord } from './durable-initiator.ts';
import delegationRead from './durable-initiator-capture-delegation.sql';

export class DurableInitiatorCaptureUnavailableError extends Error {
  constructor() {
    super('Durable initiator capture is unavailable');
    this.name = 'DurableInitiatorCaptureUnavailableError';
  }
}

/** Capture immutable creation fields after command admission, during prepare and
 * before target connection checkout or any write. Bind context with
 * commandAccessContext(context, attempt). The actor must be the exact admitted
 * account object. No account read is added: floor/operator reuse admission's
 * observation at this live attempt T. requestedBy adds one native assignment
 * unique-index seek at T, O(log A); missing, revoked or invalid evidence denies.
 * Only these allowlisted fields belong in the owning module's immutable record.
 * Unadmitted, refused, expired or mismatched contexts throw the typed error.
 */
export async function captureDurableInitiator(
  context: AccessContext,
  actor: Actor,
): Promise<Pick<DurableInitiatorRecord, 'originalAccount' | 'originalDelegation'>> {
  try {
    const attempt = accessCommandAttempt(context);
    const account = actor.kind === 'account' ? admittedCommandAccount(context, actor) : null;
    if (!attempt || !account || actor.kind !== 'account') throw new DurableInitiatorCaptureUnavailableError();
    let originalDelegation: DurableInitiatorRecord['originalDelegation'] = null;
    if (actor.requestedBy !== null) {
      const locator = /^urn:rezics:request:([^:]+):([^:]+)$/.exec(actor.requestedBy);
      const route = locator && routeOf(locator[1]!);
      if (!locator || route === null || routeOf(locator[2]!) === null)
        throw new DurableInitiatorCaptureUnavailableError();
      const row = await within(context.deadline, () =>
        delegationRead.run(deadlineClient(context.pool, context.deadline), {
          route,
          principal_id: locator[1]!,
          request_id: locator[2]!,
          actor_id: actor.accountId,
          at: authoritativeTimeValue(attempt.time),
        }),
      );
      if (!row) throw new DurableInitiatorCaptureUnavailableError();
      originalDelegation = Object.freeze({ transactionId: row.transactionId, issuedValid: row.issuedValid });
    }
    if (!admittedCommandAccount(context, actor)) throw new DurableInitiatorCaptureUnavailableError();
    return Object.freeze({ originalAccount: Object.freeze({ ...account }), originalDelegation });
  } catch (error) {
    throwAccessUnavailable(error, context.deadline);
    throw new DurableInitiatorCaptureUnavailableError();
  }
}

/** Lowercase SHA-256 of RFC 8785 canonical JSON of the entire bounded immutable
 * DurableInitiatorRecord, O(record size). Use as the native creation receipt's
 * durableInitiator response; restoration uses this identical commitment.
 */
export function durableInitiatorCommitment(record: DurableInitiatorRecord): string {
  return createHash('sha256').update(canonicalize(record)!).digest('hex');
}
