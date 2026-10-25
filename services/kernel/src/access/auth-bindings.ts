import type {
  AccessAccount,
  ProvisioningReceiptMetadata,
  EffectAuthorization,
  InvalidationReceipt,
  TrustedAccessPorts,
} from '@rezics/auth';
import type { Pool } from 'pg';
import { routeOf } from '../route/route.ts';
import { readAccount, type Account } from './account-data.ts';
import type { createLifecycleInternals, LifecycleFenceReceipt } from './lifecycle.ts';
import type { OperatorOpening } from './operator.ts';
import registrationRead from './auth-bindings-read.sql';

type ConsumeInput = Parameters<NonNullable<TrustedAccessPorts['consumeAuthorization']>>[0];
type InvalidateInput = Parameters<NonNullable<TrustedAccessPorts['invalidateAccount']>>[0];
type RecoveryInput = Parameters<NonNullable<TrustedAccessPorts['authorizeRecovery']>>[0];
export type AuthProvisioningReceipt = Awaited<
  ReturnType<ReturnType<typeof createLifecycleInternals>['createPending']>
>['value'];
export type AuthAuthorizationReceipt = {
  authorization: EffectAuthorization;
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
  consumeAuthAuthorization?: (input: ConsumeInput) => Promise<AuthAuthorizationReceipt | null>;
  invalidateAccount?: (input: InvalidateInput) => Promise<LifecycleFenceReceipt | null>;
  authorizeRecovery?: (input: RecoveryInput) => Promise<LifecycleFenceReceipt | null>;
  completeRecovery?: TrustedAccessPorts['completeRecovery'];
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
function live(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();
}
function scopes(left: string[], right: string[]): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.every((v) => typeof v === 'string') &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}
function translate(account: Account | null, recovery = false): AccessAccount | null {
  if (
    !account ||
    account.state !== 'active' ||
    (account.kind !== 'actor' && account.kind !== 'organization') ||
    (recovery ? account.kind !== 'actor' || account.operatorAccountId !== null : account.fenced)
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
export function createAuthBindings(config: { pool: Pool } & AuthBindingCapabilities): TrustedAccessPorts {
  const {
    pool,
    verifyPendingIdentity,
    verifyProvisioningReceipt,
    consumeAuthAuthorization,
    invalidateAccount,
    authorizeRecovery,
  } = config;
  async function account(id: string): Promise<Account | null> {
    const route = routeOf(id);
    if (route === null) return null;
    try {
      return await readAccount(pool, route, id);
    } catch {
      return null;
    }
  }
  async function read(id: string, recovery = false): Promise<AccessAccount | null> {
    try {
      return translate(await account(id), recovery);
    } catch {
      return null;
    }
  }
  async function provisioning(id: string | null, reference: string) {
    if (verifyPendingIdentity) {
      const pending = await verifyPendingIdentity(reference);
      allowed(pending && (id === null || pending.accountId === id) && live(pending.expiresAt));
      return pending;
    }
    if (!verifyProvisioningReceipt || typeof reference !== 'string' || reference.length === 0) return null;
    const receipt = await verifyProvisioningReceipt(reference);
    allowed(receipt && (id === null || receipt.accountId === id) && live(receipt.expiresAt));
    const current = await account(receipt.accountId);
    allowed(current && current.kind === 'actor' && current.state === 'pending' && !current.fenced);
    const authnEpoch = floor(current.minimumAuthnEpoch);
    // Registration identity/expiry are private fields absent from the ordinary reader.
    const registration = await registrationRead.run(pool, {
      route: routeOf(current.accountId)!,
      account_id: current.accountId,
      expires_at: receipt.expiresAt,
    });
    allowed(
      registration &&
        registration.registrationId === receipt.registrationId &&
        typeof receipt.registrationId === 'string' &&
        receipt.registrationId.length > 0 &&
        registration.expiresAt &&
        live(registration.expiresAt) &&
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
  return {
    ...(config.completeRecovery ? { completeRecovery: config.completeRecovery } : {}),
    readAccount: (id) => read(id),
    async readProvisioningAccount(id, reference) {
      try {
        return await provisioning(id, reference);
      } catch {
        return null;
      }
    },
    readRecoveryAccount: (id) => read(id, true),
    async authorizeProvisioning(reference) {
      if (!verifyProvisioningReceipt && !verifyPendingIdentity)
        throw new AuthBindingUnavailableError('verifyProvisioningReceipt');
      allowed(typeof reference === 'string' && reference.length > 0);
      const current = await provisioning(null, reference);
      allowed(current && (!current.automated || verifyPendingIdentity));
      return { accountId: current.accountId, ...('receipt' in current ? { receipt: current.receipt } : {}) };
    },
    async consumeAuthorization(input) {
      if (input.purpose !== 'session' && (!input.operationKey || !input.effectReference))
        throw new AuthBindingUnavailableError('consumeAuthAuthorization');
      if (!consumeAuthAuthorization) throw new AuthBindingUnavailableError('consumeAuthAuthorization');
      allowed(
        ['session', 'set-password', 'remove-password', 'add-key', 'remove-key'].includes(input.purpose) &&
          typeof input.authorization === 'string' &&
          input.authorization.length > 0 &&
          epoch(input.human.authn_epoch),
      );
      const before = await account(input.subjectAccountId);
      const human = await read(input.human.account_id, true);
      allowed(
        translate(before)?.kind === 'actor' && human && !human.fenced && input.human.authn_epoch >= human.authnEpoch,
      );
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
          live(result.expiresAt) &&
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
            live(opening.expiresAt) &&
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
      const human = translate(before, true);
      allowed(human && epoch(input.proofEpoch) && human.authnEpoch === input.proofEpoch);
      return barrier(await authorizeRecovery(input), before!, input.proofEpoch);
    },
  };
}
