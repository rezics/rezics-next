import { accessClock } from './access-clock.ts';
import { deadlineFor } from '../request/deadline.ts';
import type { AuthSessionPort } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { seal, unseal, type KeyRing } from '../tokens/seal.ts';
import { readAccount } from './account-data.ts';
import operatorAccount from './operator-account.sql';
import { AuthBindingDeniedError, AuthBindingUnavailableError, type AuthBindingCapabilities } from './auth-bindings.ts';
import type { createOperatorCommands, OperatorOpening } from './operator.ts';

/** Nonsecret native locator only. No returned JSON, epoch or permission is authority. */
export type OperatorSessionOpeningLocator = Pick<
  OperatorOpening,
  'operatorAccountId' | 'subjectAccountId' | 'receiptId'
>;
export type OperatorSessionCapability = {
  createOpeningReference(opening: OperatorSessionOpeningLocator): string;
  consumeAuthAuthorization: NonNullable<AuthBindingCapabilities['consumeAuthAuthorization']>;
};
const SCOPE = 'access.operator-session.v1';
const AUTH_SESSION_BUDGET_MS = 3_000;
function allowed(value: unknown): asserts value {
  if (!value) throw new AuthBindingDeniedError();
}
function locator(value: unknown): OperatorSessionOpeningLocator {
  allowed(typeof value === 'object' && value !== null && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  allowed(Object.keys(record).length === 3);
  for (const key of ['operatorAccountId', 'subjectAccountId', 'receiptId'])
    allowed(typeof record[key] === 'string' && routeOf(record[key]) !== null);
  allowed(record.operatorAccountId !== record.subjectAccountId);
  return record as OperatorSessionOpeningLocator;
}

/** Auth-host composition only; never install this in the membership module.
 * Supply the installed Access, actual native operator commands and a closure to
 * this Auth instance's internal.accessTokenForProof. Auth retains its database and
 * signing keys. A reference locates an opening; native consume is the authority on
 * every invocation, including retries. Lost acknowledgements fail closed without
 * reading or repairing Auth's single-use effect receipts from the kernel.
 */
export function createOperatorSessionCapability(config: {
  pool: Pool;
  access: Access;
  operators: ReturnType<typeof createOperatorCommands>;
  referenceKeys: KeyRing;
  accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
}): OperatorSessionCapability {
  const { pool, access, operators, accessTokenForProof } = config;
  // Keep a bounded private snapshot, as with the native cursor key ring.
  allowed(config.referenceKeys.keys.size > 0 && config.referenceKeys.keys.size <= 3);
  const referenceKeys = {
    current: config.referenceKeys.current,
    keys: new Map([...config.referenceKeys.keys].map(([id, key]) => [id, new Uint8Array(key)])),
  };
  allowed(referenceKeys.keys.has(referenceKeys.current));
  for (const [id, key] of referenceKeys.keys)
    allowed(Number.isInteger(id) && id >= 0 && id <= 255 && key.byteLength >= 32);
  return {
    createOpeningReference(opening) {
      const { operatorAccountId, subjectAccountId, receiptId } = opening;
      return seal(referenceKeys, SCOPE, locator({ operatorAccountId, subjectAccountId, receiptId }));
    },
    async consumeAuthAuthorization(input) {
      if (input.purpose !== 'session') throw new AuthBindingUnavailableError('consumeAuthAuthorization');
      const reference = locator(unseal(referenceKeys, SCOPE, input.authorization));
      allowed(reference.subjectAccountId === input.subjectAccountId);
      const deadline = deadlineFor(AUTH_SESSION_BUDGET_MS);
      // Only Auth's exact native human proof, live inside consumeAuthorization,
      // can mint this ordinary short JWT. It is never retained or persisted here.
      const actor = await access.authenticate(await accessTokenForProof(input.human), { pool, deadline });
      allowed(
        actor.accountId === input.human.account_id &&
          actor.clientId === input.human.client_id &&
          actor.authnEpoch === input.human.authn_epoch &&
          actor.requestedBy === null &&
          JSON.stringify(actor.scopes) === JSON.stringify(input.human.scope),
      );
      const account = await readAccount(pool, routeOf(actor.accountId)!, actor.accountId);
      const before = await operatorAccount.run(pool, {
        route: routeOf(reference.subjectAccountId)!,
        account_id: reference.subjectAccountId,
      });
      allowed(before && before.operatorAccountId === reference.operatorAccountId);
      const consumed = await operators.consumeOpening(
        { actor, account, deadline },
        { ...reference, purpose: 'session', key: `auth-session:${reference.receiptId}` },
      );
      const opening = consumed.value;
      allowed(
        !consumed.replayed &&
          opening.operatorAccountId === reference.operatorAccountId &&
          opening.subjectAccountId === reference.subjectAccountId &&
          opening.receiptId === reference.receiptId &&
          opening.actingHumanId === actor.accountId &&
          opening.clientId === actor.clientId &&
          JSON.stringify(opening.scopes) === JSON.stringify(actor.scopes) &&
          opening.requestedBy === null &&
          opening.purpose === 'session' &&
          Date.parse(opening.expiresAt) > accessClock(access)().getTime(),
      );
      const subject = await operatorAccount.run(pool, {
        route: routeOf(opening.subjectAccountId)!,
        account_id: opening.subjectAccountId,
      });
      allowed(
        subject &&
          subject.kind === 'actor' &&
          subject.state === 'active' &&
          !subject.fenced &&
          subject.operatorAccountId === opening.operatorAccountId &&
          subject.version === opening.version &&
          subject.reservationId === opening.reservationId &&
          subject.minimumAuthnEpoch === before.minimumAuthnEpoch &&
          BigInt(subject.minimumAuthnEpoch) > 0n &&
          BigInt(subject.minimumAuthnEpoch) <= BigInt(Number.MAX_SAFE_INTEGER),
      );
      return {
        operatorOpening: opening,
        authorization: {
          receiptId: opening.receiptId,
          subjectAccountId: opening.subjectAccountId,
          actingHumanId: opening.actingHumanId,
          operatorAccountId: opening.operatorAccountId,
          purpose: 'session',
          clientId: opening.clientId,
          scopes: [...opening.scopes],
          humanEpoch: actor.authnEpoch,
          subjectEpoch: Number(subject.minimumAuthnEpoch),
          expiresAt: opening.expiresAt,
        },
      };
    },
  };
}
