import { accessClock } from './access-clock.ts';
import { systemClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import { throwAccessUnavailable } from './unavailable.ts';
import type {
  AccessAccount,
  ProvisioningReceiptMetadata,
  EffectAuthorization,
  CredentialEffectAuthorization,
  CredentialFloorPurpose,
  CredentialPurpose,
  PasskeyPurpose,
  PasskeyAuthorizationInput,
  PasskeyTrustedAccessPorts,
  InvalidationReceipt,
  TrustedAccessPorts,
} from '@rezics/auth-contract';
import type { Pool } from 'pg';
import { routeOf } from '../route/route.ts';
import { readAccount, type Account } from './account-data.ts';
import type { createLifecycleInternals, LifecycleFenceReceipt } from './lifecycle.ts';
import type { OperatorOpening } from './operator.ts';
import registrationRead from './auth-bindings-read.sql';

type ConsumeInput = Parameters<NonNullable<TrustedAccessPorts['consumeAuthorization']>>[0] | PasskeyAuthorizationInput;
type InvalidateInput = Parameters<NonNullable<TrustedAccessPorts['invalidateAccount']>>[0];
type RecoveryInput = Parameters<NonNullable<TrustedAccessPorts['authorizeRecovery']>>[0];
export type AuthProvisioningReceipt = Awaited<
  ReturnType<ReturnType<typeof createLifecycleInternals>['createPending']>
>['value'];
export type AuthAuthorizationReceipt<Purpose extends CredentialFloorPurpose = CredentialPurpose> = {
  authorization: EffectAuthorization | CredentialEffectAuthorization<Purpose>;
  /** Required for automation; a broad native credential purpose never replaces the exact Auth purpose. */
  operatorOpening: OperatorOpening | null;
};

/** Trusted in-process coordinators own durable verification, single consumption and atomic
 * epoch checks. These callbacks are capabilities, never request JSON or authorization flags.
 * Workflow/provider implementations can bind here without another account or policy authority.
 */
export type AuthBindingCapabilities = {
  /** Native pending reader, including verified original receipt metadata. The
   * composition must also verify current workflow approval for automated chains. */
  verifyPendingIdentity?: (reference: string) => Promise<
    | (AccessAccount & {
        operatorAccountId: string | null;
        registrationId: string;
        expiresAt: string;
        receipt: ProvisioningReceiptMetadata;
      })
    | null
  >;
  verifyProvisioningReceipt?: (commandReference: string) => Promise<AuthProvisioningReceipt | null>;
  consumeAuthAuthorization?: (input: ConsumeInput) => Promise<AuthAuthorizationReceipt<CredentialFloorPurpose> | null>;
  invalidateAccount?: (input: InvalidateInput) => Promise<LifecycleFenceReceipt | null>;
  authorizeRecovery?: (input: RecoveryInput) => Promise<LifecycleFenceReceipt | null>;
  completeRecovery?: TrustedAccessPorts['completeRecovery'];
  confirmBarrier?: TrustedAccessPorts['confirmBarrier'];
};
export class AuthBindingUnavailableError extends Error {
  constructor(capability: keyof AuthBindingCapabilities) {
    super(`Auth binding capability unavailable: ${capability}`);
    this.name = 'AuthBindingUnavailableError';
  }
}
export class AuthBindingDeniedError extends Error {
  readonly status = 403;

  constructor() {
    super('Auth binding denied');
    this.name = 'AuthBindingDeniedError';
  }
}
function allowed(value: unknown): asserts value {
  if (!value) throw new AuthBindingDeniedError();
}
function epoch(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function floor(value: bigint): number {
  allowed(value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(value);
}
function live(value: string, at: number): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > at;
}
function scopes(left: string[], right: string[]): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.every((v) => typeof v === 'string') &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}
/** `open` denies a fence; `recovery` admits a fenced human without an operator;
 * `fenced` admits only a fenced account; `signin` additionally reports suspended humans privately. */
type ReadMode = 'open' | 'recovery' | 'fenced' | 'signin';
function admitted(account: Account, mode: ReadMode): boolean {
  if (mode === 'recovery') return account.kind === 'actor' && account.operatorAccountId === null;
  return mode === 'fenced' ? account.fenced : !account.fenced;
}
function translate(account: Account | null, mode: ReadMode = 'open'): AccessAccount | null {
  const suspendedHuman =
    mode === 'signin' &&
    account?.state === 'suspended' &&
    account.kind === 'actor' &&
    account.operatorAccountId === null;
  if (
    !account ||
    (!suspendedHuman && account.state !== 'active') ||
    (account.kind !== 'actor' && account.kind !== 'organization') ||
    (!suspendedHuman && !admitted(account, mode))
  )
    return null;
  return {
    accountId: account.accountId,
    kind: account.kind,
    state: account.state,
    authnEpoch: floor(account.minimumAuthnEpoch),
    automated: account.operatorAccountId !== null,
    fenced: account.fenced,
  };
}

/** Production Auth/Access seam. Reads use Access's existing account anchor; no local
 * account cache, policy evaluator, fence clearing or cross-account workflow runs here.
 * Callback fixtures establish this structural contract only, not product authorization.
 */
export function createAuthBindings(
  config: { pool: Pool; access?: Access } & AuthBindingCapabilities,
): PasskeyTrustedAccessPorts {
  const {
    pool,
    verifyPendingIdentity,
    verifyProvisioningReceipt,
    consumeAuthAuthorization,
    invalidateAccount,
    authorizeRecovery,
  } = config;
  const clock = config.access ? accessClock(config.access) : systemClock;
  const liveAt = (value: string) => live(value, clock().getTime());
  async function account(id: string): Promise<Account | null> {
    const route = routeOf(id);
    if (route === null) return null;
    try {
      return await readAccount(pool, route, id);
    } catch (error) {
      throwAccessUnavailable(error);
      return null;
    }
  }
  async function read(id: string, mode: ReadMode = 'open'): Promise<AccessAccount | null> {
    try {
      return translate(await account(id), mode);
    } catch (error) {
      throwAccessUnavailable(error);
      return null;
    }
  }
  async function provisioning(id: string | null, reference: string) {
    if (verifyPendingIdentity) {
      const pending = await verifyPendingIdentity(reference);
      allowed(pending && (id === null || pending.accountId === id) && liveAt(pending.expiresAt));
      return pending;
    }
    if (!verifyProvisioningReceipt || typeof reference !== 'string' || reference.length === 0) return null;
    const receipt = await verifyProvisioningReceipt(reference);
    allowed(receipt && (id === null || receipt.accountId === id) && liveAt(receipt.expiresAt));
    const current = await account(receipt.accountId);
    allowed(current && current.kind === 'actor' && current.state === 'pending' && !current.fenced);
    const authnEpoch = floor(current.minimumAuthnEpoch);
    // Registration identity/expiry are private fields absent from the ordinary reader.
    const registration = await registrationRead.run(pool, {
      route: routeOf(current.accountId)!,
      account_id: current.accountId,
      expires_at: receipt.expiresAt,
      at: clock().toISOString(),
    });
    allowed(
      registration &&
        registration.registrationId === receipt.registrationId &&
        typeof receipt.registrationId === 'string' &&
        receipt.registrationId.length > 0 &&
        registration.expiresAt &&
        liveAt(registration.expiresAt) &&
        Date.parse(registration.expiresAt) === Date.parse(receipt.expiresAt),
    );
    return {
      accountId: current.accountId,
      kind: current.kind,
      state: current.state,
      authnEpoch,
      automated: current.operatorAccountId !== null,
      fenced: current.fenced,
      registrationId: registration.registrationId!,
      expiresAt: new Date(registration.expiresAt!).toISOString(),
    };
  }
  async function barrier(
    receipt: LifecycleFenceReceipt | null,
    before: Account,
    previous: number,
  ): Promise<InvalidationReceipt> {
    allowed(
      receipt &&
        typeof receipt.receiptId === 'string' &&
        receipt.receiptId.length > 0 &&
        receipt.accountId === before.accountId &&
        typeof receipt.minimumAuthnEpoch === 'string' &&
        /^[1-9][0-9]*$/.test(receipt.minimumAuthnEpoch),
    );
    const minimumAuthnEpoch = floor(BigInt(receipt.minimumAuthnEpoch));
    const after = await account(before.accountId);
    allowed(
      minimumAuthnEpoch > previous &&
        after &&
        after.state === 'active' &&
        after.minimumAuthnEpoch === BigInt(receipt.minimumAuthnEpoch) &&
        (!before.fenced || after.fenced),
    );
    return { receiptId: receipt.receiptId, accountId: receipt.accountId, minimumAuthnEpoch };
  }
  async function erasure(id: string): Promise<AccessAccount | null> {
    const current = await account(id);
    if (!current || current.state !== 'deleted' || !current.fenced) return null;
    if (current.kind !== 'actor' && current.kind !== 'organization') return null;
    return {
      accountId: current.accountId,
      kind: current.kind,
      state: 'deleted',
      authnEpoch: floor(current.minimumAuthnEpoch),
      automated: current.operatorAccountId !== null,
      fenced: true,
    };
  }
  async function consumeFloorAuthorization(input: ConsumeInput) {
    if (input.purpose !== 'session' && (!input.operationKey || !input.effectReference))
      throw new AuthBindingUnavailableError('consumeAuthAuthorization');
    if (!consumeAuthAuthorization) throw new AuthBindingUnavailableError('consumeAuthAuthorization');
    allowed(
      ['session', 'set-password', 'remove-password', 'add-key', 'remove-key', 'add-passkey', 'remove-passkey'].includes(
        input.purpose,
      ) &&
        typeof input.authorization === 'string' &&
        input.authorization.length > 0 &&
        epoch(input.human.authn_epoch),
    );
    const before = await account(input.subjectAccountId);
    const human = await read(input.human.account_id, 'recovery');
    allowed(
      translate(before)?.kind === 'actor' && human && !human.fenced && input.human.authn_epoch >= human.authnEpoch,
    );
    if (input.purpose === 'add-passkey' || input.purpose === 'remove-passkey')
      allowed(before?.operatorAccountId === null && input.subjectAccountId === input.human.account_id);
    // Preserve Auth's actual SessionProof and caller evidence for the coordinator.
    const consumed = await consumeAuthAuthorization(input);
    const result = consumed?.authorization;
    const current = await account(input.subjectAccountId);
    const subject = translate(current);
    allowed(
      result &&
        typeof result.receiptId === 'string' &&
        result.receiptId.length > 0 &&
        result.subjectAccountId === input.subjectAccountId &&
        result.purpose === input.purpose &&
        result.actingHumanId === input.human.account_id &&
        result.humanEpoch === input.human.authn_epoch &&
        result.clientId === input.human.client_id &&
        scopes(result.scopes, input.human.scope) &&
        liveAt(result.expiresAt) &&
        subject &&
        subject.kind === 'actor' &&
        epoch(result.subjectEpoch) &&
        result.subjectEpoch === subject.authnEpoch &&
        current!.operatorAccountId === result.operatorAccountId,
    );
    if (input.purpose !== 'session')
      allowed(
        result.operationKey === input.operationKey &&
          result.effectReference === input.effectReference &&
          typeof result.effectDigest === 'string' &&
          /^[a-f0-9]{64}$/.test(result.effectDigest),
      );
    const opening = consumed!.operatorOpening;
    if (subject.automated) {
      allowed(
        opening &&
          opening.receiptId === result.receiptId &&
          opening.subjectAccountId === result.subjectAccountId &&
          opening.operatorAccountId === result.operatorAccountId &&
          opening.actingHumanId === result.actingHumanId &&
          opening.clientId === result.clientId &&
          scopes(opening.scopes, result.scopes) &&
          opening.requestedBy === null &&
          opening.purpose === (input.purpose === 'session' ? 'session' : 'credential-management') &&
          liveAt(opening.expiresAt) &&
          Date.parse(opening.expiresAt) === Date.parse(result.expiresAt),
      );
    } else allowed(!opening && result.operatorAccountId === null && result.actingHumanId === subject.accountId);
    if (result.invalidation) {
      allowed(
        epoch(result.invalidation.minimumAuthnEpoch) &&
          result.invalidation.receiptId &&
          result.invalidation.accountId === subject.accountId &&
          result.invalidation.minimumAuthnEpoch === subject.authnEpoch &&
          result.invalidation.minimumAuthnEpoch > floor(before!.minimumAuthnEpoch),
      );
    }
    return result;
  }
  return {
    passkeys: true,
    ...(config.completeRecovery ? { completeRecovery: config.completeRecovery } : {}),
    async confirmBarrier(input) {
      if (!config.confirmBarrier) throw new AuthBindingUnavailableError('confirmBarrier');
      return config.confirmBarrier(input);
    },
    readAccount: (id, purpose) => read(id, purpose === 'signin' ? 'signin' : 'open'),
    readErasureAccount: async (id) => {
      try {
        return await erasure(id);
      } catch (error) {
        throwAccessUnavailable(error);
        return null;
      }
    },
    async readProvisioningAccount(id, reference) {
      try {
        return await provisioning(id, reference);
      } catch (error) {
        throwAccessUnavailable(error);
        return null;
      }
    },
    readRecoveryAccount: (id) => read(id, 'recovery'),
    readFencedAccount: (id) => read(id, 'fenced'),
    async authorizeProvisioning(reference) {
      if (!verifyProvisioningReceipt && !verifyPendingIdentity)
        throw new AuthBindingUnavailableError('verifyProvisioningReceipt');
      allowed(typeof reference === 'string' && reference.length > 0);
      const current = await provisioning(null, reference);
      allowed(current && (!current.automated || verifyPendingIdentity));
      return { accountId: current.accountId, ...('receipt' in current ? { receipt: current.receipt } : {}) };
    },
    async consumeAuthorization(input) {
      const result = await consumeFloorAuthorization(input);
      allowed(result.purpose !== 'add-passkey' && result.purpose !== 'remove-passkey');
      return result as EffectAuthorization;
    },
    async consumePasskeyAuthorization(input) {
      allowed(input.purpose === 'add-passkey' || input.purpose === 'remove-passkey');
      allowed(input.subjectAccountId === input.human.account_id);
      const result = await consumeFloorAuthorization(input);
      return result as CredentialEffectAuthorization<PasskeyPurpose>;
    },
    async invalidateAccount(input) {
      if (!invalidateAccount) throw new AuthBindingUnavailableError('invalidateAccount');
      const before = await account(input.accountId);
      allowed(
        input.reason === 'consent-reduction' &&
          epoch(input.previousEpoch) &&
          before &&
          before.state === 'active' &&
          floor(before.minimumAuthnEpoch) === input.previousEpoch,
      );
      return barrier(await invalidateAccount(input), before, input.previousEpoch);
    },
    async authorizeRecovery(input) {
      if (!authorizeRecovery) throw new AuthBindingUnavailableError('authorizeRecovery');
      const before = await account(input.accountId);
      const human = translate(before, 'recovery');
      allowed(human && epoch(input.proofEpoch) && human.authnEpoch === input.proofEpoch);
      return barrier(await authorizeRecovery(input), before!, input.proofEpoch);
    },
  };
}
