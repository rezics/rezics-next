import type {
  AccountWorkflowPorts,
  AccountOperation as ContractAccountOperation,
  WorkflowMembership,
  WorkflowResponsibility,
  WorkflowAccount,
  WorkflowHandleTransition,
  WorkflowContext,
  WorkflowFence,
} from '@rezics/auth-contract';
export type {
  AccountWorkflowPorts,
  WorkflowMembership,
  WorkflowResponsibility,
  WorkflowAccount,
  WorkflowHandleTransition,
  WorkflowContext,
  WorkflowFence,
} from '@rezics/auth-contract';
type TransferOperation = Extract<ContractAccountOperation, { kind: 'transfer' }> & { acceptance?: string };
export type TransferAcceptanceOperation = {
  /** Approval-only counterpart to transfer. Auth workflows never execute it. */
  kind: 'transfer-acceptance';
  previous: WorkflowResponsibility;
  expectedVersion: string;
  operatorAccountId: string;
  sourceOperationKey: string;
  authorization: string;
};
/** Native hosts bind a session revocation to an approval; a callback-only historical host runs it without one. */
export type RevokeOperation = { kind: 'revoke'; accountId: string; authorization?: string };
export type AccountOperation = (
  | Exclude<ContractAccountOperation, { kind: 'transfer' | 'revoke' }>
  | RevokeOperation
  | TransferOperation
  | TransferAcceptanceOperation
) & { operationKey?: string };
type ExecutableAccountOperation = Exclude<AccountOperation, { kind: 'transfer-acceptance' }>;
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { AUTH_WORKFLOW_APPLICATION, installWorkflowRequestRetention } from './retention.ts';
import { coordinateMembership } from './membership-workflows.ts';
import { completeDeletedClientReductionOwner } from './account-workflows.ts';
import { answerRevocation, REVOKE_SESSIONS_STEP, sessionRevocation, stepFailureMessage } from './session-revocation.ts';
import { sanitizedClientIp, verifyTurnstile, type TurnstileConfiguration } from './turnstile.ts';
import type { Pool } from 'pg';
import type { AuthService } from './index.ts';

type Command = { accountId: string; key: string };
type OperatorSuspension = {
  accountId: string;
  state: 'suspended';
  receiptId: string;
  minimumAuthnEpoch: string;
};
/** Live server capability carried by the resolved operator-fencing approval.
 * This context is never persisted as workflow input. */
type OperatorSuspensionContext = {
  suspendOperator(): Promise<OperatorSuspension & { continuationOperationKey?: string }>;
};
type Reservation = { handle: string; accountId: string; reservationId: string; expiresAt: string };

export interface AccountWorkflowOptions<Context = WorkflowContext> {
  database: Pool;
  systemDatabaseUrl: string;
  /** Same-database deployments require Auth's separate native SDK schema. */
  systemDatabaseSchemaName?: string;
  systemDatabasePool?: Pool;
  /** Compose service registrations before this host's single launch. */
  registerWorkflows?: () => void;
  /** A containing service host owns signals and pool shutdown when false. */
  handleSignals?: boolean;
  /** Persistent Auth-only 32-byte key, independent of Better Auth/signing keys. */
  stagingKey: Uint8Array;
  /** Siteverify is mandatory for public registration; absent configuration denies availability. */
  turnstile?: TurnstileConfiguration;
  auth: AuthService;
  access: AccountWorkflowPorts<Context>;
  clock?: () => Date;
  executorId?: string;
}
export interface RegistrationReference {
  registrationId: string;
  workflowId: string;
  accountId: string;
  expiresAt: string;
}
type Stage = {
  registration_id: string;
  request_key: string;
  handle: string;
  account_id: string;
  reservation_id: string | null;
  expires_at: Date | null;
  completed_at: Date | null;
  expired_at: Date | null;
};
type RegistrationInput = { registrationId: string };
type RegistrationStartEvent = RegistrationReference | { error: 'handle_unavailable' };
type RegistrationCredentialEvent = { accountId: string } | { error: 'registration_denied' };
type RegistrationFailureCode = 'handle_unavailable' | 'registration_denied';
class RegistrationFailure extends Error {
  constructor(readonly code: RegistrationFailureCode) {
    super('Registration failed');
  }
}
function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === '23505';
}
/** A native refusal as it crosses the access binding: a thrown value carrying
 * the 401/403 status. Recognized by this shape, never by class name, because
 * the binding rewrites the kernel's own error classes. */
type Refusal = { readonly status: 401 | 403 };
function isRefusal(error: unknown): error is Refusal {
  return (
    typeof error === 'object' && error !== null && 'status' in error && (error.status === 401 || error.status === 403)
  );
}
let owner: object | undefined;
function denied(): never {
  throw new Error('Account workflow denied');
}
function executableOperation(input: AccountOperation): ExecutableAccountOperation {
  if (input.kind === 'transfer-acceptance') denied();
  return input;
}
function required<T>(value: T | null | undefined): T {
  if (value == null) denied();
  return value;
}
export const HANDLE_CLAIM_PATTERN = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;
const HANDLE_LOOKUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function isClaimHandle(value: unknown): value is string {
  return typeof value === 'string' && !/\s/.test(value) && HANDLE_CLAIM_PATTERN.test(value.toLowerCase());
}
function normalized(value: string) {
  if (!isClaimHandle(value)) denied();
  return value.toLowerCase();
}
function normalizedLookup(value: string) {
  if (typeof value !== 'string' || !HANDLE_LOOKUP_PATTERN.test(value)) denied();
  return value.toLowerCase();
}
function requestKey(value: string) {
  if (typeof value !== 'string' || !value || value.length > 128) denied();
  return value;
}
const responsibility = (input: WorkflowResponsibility): WorkflowResponsibility => ({
  operatorAccountId: input.operatorAccountId,
  subjectAccountId: input.subjectAccountId,
  reservationId: input.reservationId,
});
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest();
const workflowId = (key: string) => `accounts:${hash(key).toString('hex')}`;

function businessOperation(input: AccountOperation) {
  const {
    authorization: _reference,
    operationKey,
    ...operation
  } = input as AccountOperation & {
    authorization?: string;
  };
  const business = input.kind === 'automated' ? { ...operation, operationKey } : operation;
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, field]) => [key, ordered(field)]),
          )
        : value;
  return ordered(business);
}

/** One explicit Auth application owns DBOS. createAuthService has no global
 * executor side effects. Do not create two workflow hosts in one process. */
export function createAccountWorkflows<Context = WorkflowContext>(options: AccountWorkflowOptions<Context>) {
  const { database, auth, access } = options;
  if (options.stagingKey.byteLength !== 32) throw new Error('Configure a persistent 32-byte Auth staging key');
  let systemUrl: URL;
  let authUrl: URL;
  try {
    systemUrl = new URL(options.systemDatabaseUrl);
    authUrl = new URL(database.options.connectionString!);
    if (!['postgres:', 'postgresql:'].includes(systemUrl.protocol)) throw new Error();
  } catch {
    throw new Error('Invalid Auth workflow database configuration');
  }
  const sameDatabase =
    systemUrl.hostname === authUrl.hostname &&
    (systemUrl.port || '5432') === (authUrl.port || '5432') &&
    systemUrl.pathname === authUrl.pathname;
  const systemSchema = options.systemDatabaseSchemaName ?? (sameDatabase ? 'auth_dbos' : 'dbos');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(systemSchema) || (sameDatabase && systemSchema !== 'auth_dbos'))
    throw new Error('Auth workflows require an isolated native system schema');
  const key = Buffer.from(hkdfSync('sha256', options.stagingKey, '', 'rezics.auth.registration-staging.v1', 32));
  const digestKey = Buffer.from(hkdfSync('sha256', options.stagingKey, '', 'rezics.auth.registration-binding.v1', 32));
  const token = {};
  const clock = options.clock ?? (() => new Date());
  const now = () => {
    const at = clock();
    if (!Number.isFinite(at.getTime())) denied();
    return at;
  };
  const bindingDigest = (data: unknown) => createHmac('sha256', digestKey).update(JSON.stringify(data)).digest();
  let started = false;
  let starting: Promise<void> | undefined;
  let registered = false;
  const active = () => {
    if (!started || owner !== token) throw new Error('Start the Auth workflow host first');
  };
  async function stage(id: string): Promise<Stage> {
    return required(
      (
        await database.query<Stage>(
          'SELECT registration_id, request_key, handle, account_id, reservation_id, expires_at, completed_at, expired_at FROM auth_registration_stage WHERE registration_id=$1',
          [id],
        )
      ).rows[0],
    );
  }
  const reference = (row: Stage): RegistrationReference => ({
    registrationId: row.registration_id,
    workflowId: workflowId(`registration:${row.request_key}`),
    accountId: row.account_id,
    expiresAt: required(row.expires_at).toISOString(),
  });
  function sealCredential(id: string, accountId: string, handle: string, input: { email: string; password: string }) {
    if (
      typeof input.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
      input.email.length > 254 ||
      typeof input.password !== 'string' ||
      input.password.length < 8 ||
      input.password.length > 128
    )
      denied();
    const credential = { email: input.email.toLowerCase(), password: input.password };
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([id, accountId, handle])));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
    return { ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), digest: bindingDigest(credential) };
  }
  async function createStage(
    input: { key: string; handle: string },
    credential?: { email: string; password: string },
    binding?: unknown,
  ) {
    const request = requestKey(input.key);
    const handle = normalized(input.handle);
    const creation = binding === undefined ? null : businessOperation(binding as AccountOperation);
    const digest = hash(creation === null ? [handle] : [handle, creation]);
    const id = randomBytes(24).toString('base64url');
    const accountId = access.registrationTarget(request);
    const sealed = credential ? sealCredential(id, accountId, handle, credential) : null;
    const result = await database.query<Stage & { request_digest: Buffer; credential_digest: Buffer | null }>(
      'INSERT INTO auth_registration_stage (registration_id,request_key,handle,account_id,request_digest,ciphertext,credential_digest,creation_binding) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *',
      [id, request, handle, accountId, digest, sealed?.ciphertext ?? null, sealed?.digest ?? null, creation],
    );
    const row = required(result.rows[0]);
    if (
      !row.request_digest.equals(digest) ||
      row.account_id !== accountId ||
      (sealed && !row.credential_digest?.equals(sealed.digest))
    )
      throw new RegistrationFailure('registration_denied');
    return row;
  }
  async function approved(input: AccountOperation): Promise<Context> {
    const executable = executableOperation(input);
    if (
      !('authorization' in executable) ||
      typeof executable.authorization !== 'string' ||
      executable.authorization.length === 0 ||
      executable.authorization.length > 4096
    )
      denied();
    const current = await currentOperation(executable);
    if (!('authorization' in current)) denied();
    return required(access.authorizeOperation)(current.authorization, current);
  }
  async function currentOperation(input: AccountOperation): Promise<ExecutableAccountOperation> {
    const executable = executableOperation(input);
    let current = executable;
    if (DBOS.workflowID) {
      const stored = (
        await database.query<{ request: AccountOperation }>(
          'SELECT request FROM auth_workflow_request WHERE workflow_id=$1',
          [DBOS.workflowID],
        )
      ).rows[0]?.request;
      if (stored) {
        const executable = executableOperation(stored);
        if (JSON.stringify(businessOperation(executable)) !== JSON.stringify(businessOperation(current))) denied();
        current = executable;
      }
    }
    return current;
  }
  const commandKey = (phase: string) => `wf:${required(DBOS.workflowID)}:${phase}`;
  async function authorizedKey(request: AccountOperation | undefined, phase: string) {
    if (!request) return commandKey(phase);
    const context = await approved(request);
    return access.stableCommandKey?.(context, phase) ?? commandKey(phase);
  }
  const step = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    DBOS.registerStep(
      async (...args: A) => {
        try {
          return await fn(...args);
        } catch (error) {
          const failure = new Error(stepFailureMessage(name));
          // Persist only the native refusal status, never the command's secret
          // input, permission context or original error in a durable step.
          if (isRefusal(error)) throw Object.assign(failure, { status: 403 });
          throw failure;
        }
      },
      { name: `accounts.${name}`, retriesAllowed: false },
    );

  // Functions are registered on start, and recreated after a clean SDK shutdown.
  let registration: (input: RegistrationInput) => Promise<{ accountId: string; expired?: true }>;
  let operation: (input: AccountOperation) => Promise<{ accountId: string } | OperatorSuspension>;
  type ReductionInput = Extract<AccountOperation, { kind: 'client-reduction' }> & {
    operationId?: string;
    after?: string;
  };
  type ReductionResult = { clientId: string; nextWorkflowId?: string };
  let clientReduction: (input: ReductionInput) => Promise<ReductionResult>;
  function register() {
    const read = step('read-registration', async (id: string, request?: AccountOperation) => {
      if (request) await approved(request);
      return stage(id);
    });
    const reserve = step(
      'reserve-handle',
      async (row: Stage, request?: AccountOperation) =>
        (
          await access.reserveHandle(
            {
              handle: row.handle,
              accountId: row.account_id,
              key: await authorizedKey(request, 'reserve-handle'),
            },
            request ? await approved(request) : undefined,
          )
        ).value,
    );
    const reservePublicRegistration = step('reserve-public-registration-handle', async (row: Stage) => {
      try {
        return {
          claim: (
            await access.reserveHandle({
              handle: row.handle,
              accountId: row.account_id,
              key: commandKey('reserve-handle'),
            })
          ).value,
        } as const;
      } catch (error) {
        if (isRefusal(error)) return { error: 'handle_unavailable' as const };
        throw error;
      }
    });
    const pending = step('pending-account', async (claim: Reservation, id: string, request?: AccountOperation) => {
      const result = await access.createPending({ ...claim, key: await authorizedKey(request, 'pending-account') });
      await database.query(
        'UPDATE auth_registration_stage SET reservation_id=$2, expires_at=$3 WHERE registration_id=$1 AND (reservation_id IS NULL OR reservation_id=$2)',
        [id, claim.reservationId, claim.expiresAt],
      );
      return result.value;
    });
    const isExpired = step('registration-expired', async (id: string) => {
      const row = await stage(id);
      return !!row.expired_at || required(row.expires_at).getTime() <= now().getTime();
    });
    const provision = step(
      'install-credential',
      async (id: string, request?: AccountOperation, publicRegistration = false) => {
        if (request) await approved(request);
        const row = await stage(id);
        if (row.expired_at || required(row.expires_at).getTime() <= now().getTime())
          return { accountId: row.account_id, expired: true as const };
        const authorization = await access.provisioningReference({
          accountId: row.account_id,
          reservationId: required(row.reservation_id),
          ...(request ? { operation: await currentOperation(request) } : {}),
        });
        const encrypted = required(
          (
            await database.query<{ ciphertext: Buffer }>(
              'SELECT ciphertext FROM auth_registration_stage WHERE registration_id=$1',
              [id],
            )
          ).rows[0]?.ciphertext,
        );
        const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
        decipher.setAAD(Buffer.from(JSON.stringify([id, row.account_id, row.handle])));
        decipher.setAuthTag(encrypted.subarray(12, 28));
        const clear = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
        try {
          const credential = JSON.parse(clear.toString('utf8')) as { email: string; password: string };
          try {
            return await auth.internal.provisionPassword({
              authorization,
              ...credential,
              idempotencyKey: `registration:${id}`,
            });
          } catch (error) {
            if (publicRegistration && isUniqueViolation(error))
              return { accountId: row.account_id, conflict: 'registration_denied' as const };
            throw error;
          }
        } finally {
          clear.fill(0);
        }
      },
    );
    const evidence = step('provisioning-evidence', async (claim: Reservation, request?: AccountOperation) => {
      if (request) await approved(request);
      return access.provisioningEvidence(claim);
    });
    const claimHandle = step(
      'claim-handle',
      async (claim: Reservation, proof: unknown, id: string, request?: AccountOperation) => {
        try {
          return (
            await access.claimHandle({ ...claim, evidence: proof, key: await authorizedKey(request, 'claim-handle') })
          ).value;
        } catch {
          const row = await stage(id);
          if (required(row.expires_at).getTime() <= now().getTime())
            return { accountId: row.account_id, expired: true as const };
          throw new Error('Handle barrier unavailable');
        }
      },
    );
    const activate = step(
      'activate-account',
      async (accountId: string, proof: unknown, id: string, request?: AccountOperation) => {
        try {
          // A committed activation receipt wins on replay, even past the pending
          // deadline. An uncommitted activation still uses Access's original TTL.
          return (await access.activate({ accountId, evidence: proof, key: await authorizedKey(request, 'activate') }))
            .value;
        } catch {
          const row = await stage(id);
          if (required(row.expires_at).getTime() <= now().getTime()) return { accountId, expired: true as const };
          throw new Error('Activation unavailable');
        }
      },
    );
    const defaults = step(
      'operator-management-defaults',
      async (operatorAccountId: string, request?: AccountOperation) => {
        if (access.provisionManagementDefaults)
          await access.provisionManagementDefaults({
            operatorAccountId,
            key: await authorizedKey(request, 'management-defaults'),
          });
      },
    );
    const complete = step('registration-complete', async (id: string, request?: AccountOperation) => {
      if (request) await approved(request);
      await database.query(
        'UPDATE auth_registration_stage SET completed_at=$2,ciphertext=NULL WHERE registration_id=$1 AND expired_at IS NULL',
        [id, now()],
      );
    });
    const expire = step('expire-registration', async (claim: Reservation) => {
      await access.expireRegistration({ ...claim, key: commandKey('expire') });
    });
    const release = step('release-expired-handle', async (claim: Reservation) => {
      await access.releaseExpiredRegistrationHandle({ ...claim, key: commandKey('release-expired') });
    });
    const erase = step(
      'erase-auth-owner',
      async (accountId: string, request?: AccountOperation, operationKey?: string) => {
        if (operationKey) {
          const row = required(await required(access.readContinuation)(operationKey, accountId));
          const entry = row.allowlist.find((item) => item.step === 'erase-auth-owner' && item.target === accountId);
          if (!entry) denied();
          await required(access.authorizeContinuation)(row.reference, entry);
        } else if (request) await approved(request);
        return auth.internal.eraseAccount(accountId);
      },
    );
    const expired = step('registration-terminal', async (id: string) => {
      await database.query(
        'UPDATE auth_registration_stage SET expired_at=$2,ciphertext=NULL WHERE registration_id=$1 AND completed_at IS NULL',
        [id, now()],
      );
    });
    registration = DBOS.registerWorkflow(
      async (input: RegistrationInput) => {
        const row = await read(input.registrationId);
        const reserved = await reservePublicRegistration(row);
        if ('error' in reserved) {
          await DBOS.setEvent('pending', reserved);
          return { accountId: row.account_id, error: reserved.error };
        }
        const claim = reserved.claim;
        await pending(claim, input.registrationId);
        const ref = {
          registrationId: input.registrationId,
          workflowId: required(DBOS.workflowID),
          accountId: row.account_id,
          expiresAt: claim.expiresAt,
        };
        await DBOS.setEvent('pending', ref);
        const first = await DBOS.recv<string>('credential', { deadlineEpochMS: Date.parse(claim.expiresAt) });
        if (first !== 'expire' && !(await isExpired(input.registrationId))) {
          const installed = await provision(input.registrationId, undefined, true);
          if ('conflict' in installed) {
            await expire(claim);
            await release(claim);
            await erase(row.account_id);
            await expired(input.registrationId);
            const deniedEvent = { error: 'registration_denied' as const };
            await DBOS.setEvent('credential', deniedEvent);
            return { accountId: row.account_id, error: deniedEvent.error };
          }
          if (!('expired' in installed)) {
            const proof = await evidence(claim);
            const claimed = await claimHandle(claim, proof, input.registrationId);
            if (!('expired' in claimed)) {
              await DBOS.setEvent('credential', { accountId: row.account_id });
              const next = await DBOS.recv<string>('activation', { deadlineEpochMS: Date.parse(claim.expiresAt) });
              if (next !== 'expire' && !(await isExpired(input.registrationId))) {
                const result = await activate(row.account_id, proof, input.registrationId);
                if (!('expired' in result)) {
                  await defaults(row.account_id);
                  await complete(input.registrationId);
                  return result;
                }
              }
            }
          }
        }
        await expire(claim);
        await release(claim);
        await erase(row.account_id);
        await expired(input.registrationId);
        return { accountId: row.account_id, expired: true as const };
      },
      { name: 'accounts.registration' },
    );

    const fence = step(
      'fence',
      async (accountId: string, request?: Extract<AccountOperation, { kind: 'fence-operator' | 'revoke' }>) => {
        if (request?.kind === 'revoke') {
          // One native command: the person's floor, fence and receipt commit together, with the continuation
          // that later lets Auth revoke. The actor is resolved here, once, before the fence it is about to raise.
          const revokeSessions = sessionRevocation(await approved(request));
          if (!revokeSessions) denied();
          return revokeSessions();
        }
        if (request) {
          const context = await approved(request);
          if (
            !context ||
            typeof context !== 'object' ||
            !('suspendOperator' in context) ||
            typeof context.suspendOperator !== 'function'
          )
            denied();
          const value = await (context as OperatorSuspensionContext).suspendOperator();
          return { ...value, kind: 'fence', priorOperatorAccountId: null };
        }
        return (await access.raiseFence({ accountId, key: commandKey(`fence:${accountId}`) })).value;
      },
    );
    const revoke = step(
      REVOKE_SESSIONS_STEP,
      async (accountId: string, request?: AccountOperation, operationKey?: string) => {
        if (operationKey) {
          const root = required(await required(access.readContinuation)(operationKey, accountId));
          const entry = root.allowlist.find(
            (item) => item.step === 'revoke-auth-sessions' && item.target === accountId,
          );
          if (!entry) denied();
          await required(access.authorizeContinuation)(root.reference, entry);
        } else if (request) await approved(request);
        return auth.internal.revokeSessions(accountId);
      },
    );
    const hold = step('hold-new-handle', async (input: WorkflowHandleTransition, request?: AccountOperation) => {
      await required(access.holdHandle)({ ...input, key: await authorizedKey(request, 'hold-handle') });
    });
    const publish = step('publish-handle', async (input: WorkflowHandleTransition, request: AccountOperation) => {
      const context = await approved(request);
      await required(access.transitionAccountHandle)(context, {
        ...input,
        key: access.stableCommandKey?.(context, 'publish-handle') ?? commandKey('publish-handle'),
      });
    });
    const finalize = step('finalize-handle', async (input: WorkflowHandleTransition, request?: AccountOperation) => {
      await required(access.finalizeHandleTransition)({
        ...input,
        key: await authorizedKey(request, 'finalize-handle'),
      });
    });
    const redirect = step(
      'redirect-old-handle',
      async (input: WorkflowHandleTransition, request?: AccountOperation) => {
        await required(access.redirectTransitionHandle)({
          ...input,
          key: await authorizedKey(request, 'redirect-handle'),
        });
      },
    );
    const finishHandle = step(
      'complete-handle-operation',
      async (input: WorkflowHandleTransition, request?: AccountOperation) => {
        await required(access.completeHandleTransition)({
          ...input,
          key: await authorizedKey(request, 'complete-handle'),
        });
      },
    );
    const organizationKey = step('organization-key', async (request: AccountOperation, phase: string) => {
      const context = await approved(request);
      return required(access.stableCommandKey)(context, phase);
    });
    const reserveOwner = step('reserve-owner', async (input: AccountOperation, organizationId: string) => {
      const context = await approved(input);
      const ownerAccountId = required(access.actorAccountId)(context);
      return (
        await required(access.reserveCoordination)({
          accountId: ownerAccountId,
          relatedAccountId: organizationId,
          purpose: 'membership',
          key: access.stableCommandKey?.(context, 'reserve-owner') ?? commandKey('reserve-owner'),
        })
      ).value;
    });
    const organization = step(
      'create-organization',
      async (organizationId: string, ownerAccountId: string, ownerReservationId: string, request: AccountOperation) =>
        (
          await required(access.createOrganization)({
            organizationId,
            ownerAccountId,
            ownerReservationId,
            key: await authorizedKey(request, 'organization'),
          })
        ).value,
    );
    const bootstrap = step(
      'bootstrap-organization-handle',
      async (
        input: WorkflowHandleTransition,
        ownerAccountId: string,
        ownerReservationId: string,
        request: AccountOperation,
      ) => {
        await required(access.bootstrapOrganizationHandle)({
          ...input,
          ownerAccountId,
          ownerReservationId,
          key: await authorizedKey(request, 'bootstrap-handle'),
        });
      },
    );
    const reserveMember = step('reserve-member', async (input: Extract<AccountOperation, { kind: 'membership' }>) => {
      // The one authorization of this step precedes the hold it writes.
      const context = await approved(input);
      return (
        await required(access.reserveCoordination)({
          accountId: input.memberAccountId,
          relatedAccountId: input.organizationId,
          purpose: 'membership',
          key: access.stableCommandKey?.(context, 'reserve-member') ?? commandKey('reserve-member'),
        })
      ).value;
    });
    const changeMember = step(
      'change-membership',
      async (input: WorkflowMembership & { role: 'owner' | 'member' | null }, request: AccountOperation) => {
        const context = await approved(request);
        await required(access.setMembership)(context, {
          ...input,
          key: access.stableCommandKey?.(context, 'change-membership') ?? commandKey('change-membership'),
        });
        // Releasing the hold completes this committed change. The actor may have
        // just lost the right it used, so release is keyed here and never re-authorized.
        return {
          releaseKey: access.stableCommandKey?.(context, 'release-membership') ?? commandKey('release-membership'),
        };
      },
    );
    const releaseMember = step('release-membership', async (input: WorkflowMembership, releaseKey: string) => {
      await required(access.releaseMembershipCoordination)({ ...input, key: releaseKey });
    });
    const reserveOperator = step(
      'reserve-operator',
      async (request: AccountOperation, operatorAccountId: string, subjectAccountId: string) => {
        return (
          await required(access.reserveResponsibility)({
            operatorAccountId,
            subjectAccountId,
            key: await authorizedKey(request, 'reserve-operator'),
          })
        ).value;
      },
    );
    const relation = step(
      'record-operator',
      async (
        input: WorkflowResponsibility,
        previous: string | null,
        version: string,
        request: AccountOperation,
        pendingReservationId?: string,
      ) => {
        return (
          await required(access.recordOperatorRelation)(
            {
              ...input,
              expectedOperatorAccountId: previous,
              expectedVersion: version,
              key: await authorizedKey(request, 'record-operator'),
            },
            pendingReservationId
              ? { reservationId: pendingReservationId, operation: await currentOperation(request) }
              : undefined,
          )
        ).value;
      },
    );
    const retireOperator = step(
      'retire-operator',
      async (input: WorkflowResponsibility, request?: AccountOperation, operationKey?: string) => {
        if (operationKey) {
          const row = required(await required(access.readContinuation)(operationKey, input.subjectAccountId));
          const entry = row.allowlist.find(
            (item) =>
              item.step === 'retire-operator' && item.target === `${input.subjectAccountId}:${input.reservationId}`,
          );
          if (!entry) denied();
          await required(access.authorizeContinuation)(row.reference, entry);
          await required(access.retireResponsibility)({ ...input, key: entry.key });
          return;
        }
        await required(access.retireResponsibility)({ ...input, key: await authorizedKey(request, 'retire-operator') });
      },
    );
    const releaseOperator = step(
      'release-operator',
      async (input: WorkflowResponsibility, request?: AccountOperation, operationKey?: string) => {
        if (operationKey) {
          const row = required(await required(access.readContinuation)(operationKey, input.subjectAccountId));
          const entry = row.allowlist.find(
            (item) =>
              item.step === 'release-operator' && item.target === `${input.operatorAccountId}:${input.reservationId}`,
          );
          if (!entry) denied();
          await required(access.authorizeContinuation)(row.reference, entry);
          await required(access.releaseResponsibility)({ ...input, key: entry.key });
          return;
        }
        await required(access.releaseResponsibility)({
          ...input,
          key: await authorizedKey(request, 'release-operator'),
        });
      },
    );
    const cancelTransferOperator = step(
      'cancel-transfer-operator',
      async (input: WorkflowResponsibility, request: AccountOperation) => {
        await required(access.retireResponsibility)({
          ...input,
          key: await authorizedKey(request, 'cancel-transfer-operator'),
        });
        await required(access.releaseResponsibility)({
          ...input,
          key: await authorizedKey(request, 'release-cancelled-transfer-operator'),
        });
      },
    );
    const credentialless = step('credentialless-owner', async (claim: Reservation, request?: AccountOperation) => {
      if (request) await approved(request);
      const authorization = await access.provisioningReference({
        ...claim,
        ...(request ? { operation: await currentOperation(request) } : {}),
      });
      return auth.internal.provisionCredentialless({ authorization });
    });
    const hasCredential = step('has-staged-credential', async (id: string, request?: AccountOperation) => {
      if (request) await approved(request);
      return !!(
        await database.query(
          'SELECT registration_id FROM auth_registration_stage WHERE registration_id=$1 AND ciphertext IS NOT NULL',
          [id],
        )
      ).rowCount;
    });
    const inspect = step(
      'account-before-deletion',
      async (id: string, request: AccountOperation): Promise<WorkflowAccount> => {
        await approved(request);
        const value = required(await access.readAccount(id));
        return {
          accountId: value.accountId,
          handle: value.handle,
          operatorAccountId: value.operatorAccountId,
          state: value.state,
          fenced: value.fenced,
        };
      },
    );
    const tombstone = step('tombstone-account', async (input: Extract<AccountOperation, { kind: 'delete' }>) => {
      const context = await approved(input);
      const binding = access.approvalBinding?.(context);
      const value = (
        await required(access.tombstone)(context, {
          accountId: input.accountId,
          key: binding ? `${binding.commandKeyPrefix}:tombstone` : await authorizedKey(input, 'tombstone'),
          ...(binding
            ? {
                continuation: {
                  operationKey: binding.operationKey,
                  operationDigest: binding.digest,
                  commandKeyPrefix: binding.commandKeyPrefix,
                },
              }
            : {}),
        })
      ).value;
      return binding ? { ...value, continuationOperationKey: binding.operationKey } : value;
    });
    const redirectDeleted = step(
      'redirect-deleted-handle',
      async (accountId: string, handle: string, request?: AccountOperation, operationKey?: string) => {
        if (operationKey) {
          const row = required(await required(access.readContinuation)(operationKey, accountId));
          const entry = row.allowlist.find((item) => item.step === 'redirect-deleted-handle' && item.target === handle);
          if (!entry) denied();
          await required(access.authorizeContinuation)(row.reference, entry);
          await required(access.redirectHandle)({ accountId, handle, key: entry.key });
          return;
        }
        await required(access.redirectHandle)({
          accountId,
          handle,
          key: await authorizedKey(request, 'redirect-deleted'),
        });
      },
    );
    const authorize = step('authorize-account-operation', async (input: AccountOperation) => {
      await approved(input);
    });
    const consent = step(
      'reduce-consent',
      async (input: Extract<AccountOperation, { kind: 'consent' }>, barrier: WorkflowFence) => {
        await auth.internal.reduceConsent({
          accountId: input.accountId,
          clientId: input.clientId,
          scopes: input.scopes,
          barrier: {
            accountId: barrier.accountId,
            receiptId: barrier.receiptId,
            minimumAuthnEpoch: Number(barrier.minimumAuthnEpoch),
          },
        });
      },
    );
    const beginReduction = step(
      'begin-client-reduction',
      async (input: Extract<AccountOperation, { kind: 'client-reduction' }>) => {
        await approved(input);
        await auth.internal.beginClientReduction({ ...input, operationId: required(DBOS.workflowID) });
      },
    );
    const reductionPage = step('client-reduction-page', async (clientId: string, operationId: string, after: string) =>
      auth.internal.clientReductionPage({ clientId, operationId, after, limit: 64 }),
    );
    const reductionOwnerFence = step(
      'client-reduction-owner-fence',
      async (clientId: string, operationId: string, accountId: string) => {
        const completeDeleted = () =>
          completeDeletedClientReductionOwner(database, access.readAccount, {
            clientId,
            operationId,
            accountId,
          });
        if (await completeDeleted()) return null;
        try {
          return (await access.raiseFence({ accountId, key: commandKey(`fence:${accountId}`) })).value;
        } catch (error) {
          // Deletion may commit after the read and before the native fence.
          // Only its terminal state can discharge that lifecycle refusal.
          if (!isRefusal(error) || !(await completeDeleted())) throw error;
          return null;
        }
      },
    );
    const revokeReduction = step('revoke-client-reduction-sessions', async (barrier: WorkflowFence) =>
      auth.internal.revokeSessions(barrier.accountId, {
        boundedCleanup: true,
        barrier: { ...barrier, minimumAuthnEpoch: Number(barrier.minimumAuthnEpoch) },
      }),
    );
    const completedOwner = step(
      'complete-client-reduction-owner',
      async (clientId: string, operationId: string, barrier: WorkflowFence) =>
        auth.internal.completeClientReductionOwner({
          clientId,
          operationId,
          accountId: barrier.accountId,
          barrier: { ...barrier, minimumAuthnEpoch: Number(barrier.minimumAuthnEpoch) },
        }),
    );
    const finishReduction = step('finish-client-reduction', async (input: ReductionInput, operationId: string) => {
      await auth.internal.finishClientReduction({ ...input, operationId });
    });
    clientReduction = DBOS.registerWorkflow(
      async (input: ReductionInput): Promise<ReductionResult> => {
        const operationId = input.operationId ?? required(DBOS.workflowID);
        if (!input.operationId) await beginReduction(input);
        const batch = await reductionPage(input.clientId, operationId, input.after ?? '');
        for (const id of batch.items) {
          const barrier = await reductionOwnerFence(input.clientId, operationId, id);
          if (!barrier) continue;
          await revokeReduction(barrier);
          await completedOwner(input.clientId, operationId, barrier);
        }
        if (batch.next !== null) {
          // Each durable workflow has one bounded page. It schedules, but does
          // not await, its continuation, so history and recovery stay bounded.
          const nextWorkflowId = `${operationId}:page:${hash(batch.next).toString('hex')}`;
          await DBOS.startWorkflow(clientReduction, { workflowID: nextWorkflowId })({
            ...input,
            operationId,
            after: batch.next,
          });
          return { clientId: input.clientId, nextWorkflowId };
        }
        await finishReduction(input, operationId);
        return { clientId: input.clientId };
      },
      { name: 'accounts.client-reduction' },
    );
    operation = DBOS.registerWorkflow(
      async (input: AccountOperation) => {
        if (input.kind === 'membership') {
          if (input.role === null && !input.reservationId) denied();
          let releaseKey: string | undefined;
          await coordinateMembership({
            leaving: input.role === null,
            reserve: async () => ({
              organizationId: input.organizationId,
              memberAccountId: input.memberAccountId,
              reservationId: input.reservationId ?? (await reserveMember(input)).reservationId,
            }),
            publish: async (membership) => {
              releaseKey = (await changeMember({ ...membership, role: input.role }, input)).releaseKey;
            },
            release: (membership) => releaseMember(membership, required(releaseKey)),
          });
          return { accountId: input.memberAccountId };
        }
        if (input.kind === 'transfer') {
          const held = await reserveOperator(input, input.operatorAccountId, input.previous.subjectAccountId);
          try {
            await relation(held, input.previous.operatorAccountId, input.expectedVersion, input);
          } catch (error) {
            // An authorized cancellation terminalizes a held destination slot
            // after a pre-publication failure. Revoked authority leaves it held.
            await cancelTransferOperator(held, input);
            throw error;
          }
          await revoke(input.previous.subjectAccountId, input);
          await retireOperator(input.previous, input);
          await releaseOperator(input.previous, input);
          return { accountId: held.subjectAccountId };
        }
        if (input.kind === 'delete') {
          await authorize(input);
          const account = await inspect(input.accountId, input);
          if (
            account.operatorAccountId !== (input.responsibility?.operatorAccountId ?? null) ||
            (input.responsibility && input.responsibility.subjectAccountId !== input.accountId)
          )
            denied();
          const barrier = await tombstone(input);
          const operationKey = 'continuationOperationKey' in barrier ? barrier.continuationOperationKey : undefined;
          if (operationKey) {
            await erase(input.accountId, undefined, operationKey);
            if (input.responsibility) {
              await retireOperator(input.responsibility, undefined, operationKey);
              await releaseOperator(input.responsibility, undefined, operationKey);
            }
            if (account.handle) await redirectDeleted(account.accountId, account.handle, undefined, operationKey);
            return { accountId: input.accountId };
          }
          await erase(input.accountId, input);
          if (input.responsibility) {
            await retireOperator(input.responsibility, input);
            await releaseOperator(input.responsibility, input);
          }
          if (account.handle) await redirectDeleted(account.accountId, account.handle, input);
          return { accountId: input.accountId };
        }
        if (input.kind === 'fence-operator') {
          await authorize(input);
          const barrier = await fence(input.accountId, input);
          const operationKey = 'continuationOperationKey' in barrier ? barrier.continuationOperationKey : undefined;
          if (typeof operationKey !== 'string') denied();
          await revoke(input.accountId, undefined, operationKey);
          return {
            accountId: barrier.accountId,
            state: 'suspended' as const,
            minimumAuthnEpoch: barrier.minimumAuthnEpoch,
            receiptId: barrier.receiptId,
          };
        }
        if (input.kind === 'consent') {
          await authorize(input);
          const barrier = await fence(input.accountId);
          await consent(input, barrier);
          await revoke(input.accountId);
          return { accountId: input.accountId };
        }
        if (input.kind === 'automated') {
          const row = await read(input.registrationId, input);
          const claim = await reserve(row, input);
          const held = await reserveOperator(input, input.operatorAccountId, row.account_id);
          await pending(claim, input.registrationId, input);
          await relation(held, null, '0', input, claim.reservationId);
          const installed = (await hasCredential(input.registrationId, input))
            ? await provision(input.registrationId, input)
            : await credentialless(claim, input);
          if (!('expired' in installed)) {
            const proof = await evidence(claim, input);
            const claimed = await claimHandle(claim, proof, input.registrationId, input);
            if (!('expired' in claimed)) {
              const activated = await activate(row.account_id, proof, input.registrationId, input);
              if (!('expired' in activated)) {
                await complete(input.registrationId, input);
                return { accountId: row.account_id };
              }
            }
          }
          await expire(claim);
          await release(claim);
          await erase(row.account_id);
          await retireOperator(held);
          await releaseOperator(held);
          await expired(input.registrationId);
          denied();
        }
        if (input.kind === 'revoke') {
          if (!('authorization' in input)) {
            await fence(input.accountId);
            await revoke(input.accountId);
            return { accountId: input.accountId };
          }
          // Access first: the fence, its receipt and the continuation commit before Auth deletes anything.
          const barrier = await fence(input.accountId, input);
          const operationKey = 'continuationOperationKey' in barrier ? barrier.continuationOperationKey : undefined;
          if (typeof operationKey !== 'string') denied();
          await revoke(input.accountId, undefined, operationKey);
          return { accountId: input.accountId };
        }
        if (input.kind === 'rename' || input.kind === 'organization') {
          const accountId =
            input.kind === 'rename'
              ? input.accountId
              : access.registrationTarget(await organizationKey(input, 'organization-id'));
          const owner = input.kind === 'organization' ? await reserveOwner(input, accountId) : null;
          if (owner) {
            await organization(accountId, owner.accountId, owner.reservationId, input);
            await defaults(accountId, input);
          }
          const claim = await reserve({ account_id: accountId, handle: input.handle } as Stage, input);
          const transition = {
            accountId,
            handle: claim.handle,
            reservationId: claim.reservationId,
            expectedHandle: input.kind === 'rename' ? input.expectedHandle : null,
            operationId:
              input.kind === 'organization'
                ? await organizationKey(input, 'handle-operation')
                : required(DBOS.workflowID),
            key: input.kind === 'organization' ? await organizationKey(input, 'transition') : commandKey('transition'),
          };
          await hold(transition, input);
          if (owner) await bootstrap(transition, owner.accountId, owner.reservationId, input);
          else await publish(transition, input);
          await finalize(transition, input);
          if (transition.expectedHandle !== null) await redirect(transition, input);
          await finishHandle(transition, input);
          return { accountId };
        }
        denied();
      },
      { name: 'accounts.operation' },
    );
    registered = true;
  }
  async function begin(input: { key: string; handle: string }, credential?: { email: string; password: string }) {
    active();
    const row = await createStage(input, credential);
    await DBOS.startWorkflow(registration, { workflowID: workflowId(`registration:${row.request_key}`) })({
      registrationId: row.registration_id,
    });
    const result = required(
      await DBOS.getEvent<RegistrationStartEvent>(workflowId(`registration:${row.request_key}`), 'pending', 30),
    );
    if ('error' in result) throw new RegistrationFailure(result.error);
    return result;
  }
  async function install(input: { registrationId: string; email: string; password: string }) {
    active();
    const row = await stage(input.registrationId);
    if (row.expired_at || (!row.completed_at && required(row.expires_at).getTime() <= now().getTime())) denied();
    const { ciphertext, digest } = sealCredential(row.registration_id, row.account_id, row.handle, input);
    const changed = await database.query(
      'UPDATE auth_registration_stage SET ciphertext=CASE WHEN credential_digest IS NULL THEN $2 ELSE ciphertext END, credential_digest=$3 WHERE registration_id=$1 AND (credential_digest IS NULL OR credential_digest=$3) RETURNING registration_id',
      [row.registration_id, ciphertext, digest],
    );
    if (!changed.rowCount) throw new RegistrationFailure('registration_denied');
    const ref = reference(row);
    await DBOS.send(ref.workflowId, 'install', 'credential', `${ref.workflowId}:install`);
    const result = required(await DBOS.getEvent<RegistrationCredentialEvent>(ref.workflowId, 'credential', 30));
    if ('error' in result) throw new RegistrationFailure(result.error);
    return result;
  }
  async function activateRegistration(id: string) {
    active();
    const row = await stage(id);
    if (row.expired_at || (!row.completed_at && required(row.expires_at).getTime() <= now().getTime())) denied();
    const ref = reference(row);
    await DBOS.send(ref.workflowId, 'activate', 'activation', `${ref.workflowId}:activate`);
    const result = await DBOS.retrieveWorkflow<{ accountId: string; expired?: true }>(ref.workflowId).getResult();
    if (result.expired) denied();
    return { accountId: result.accountId };
  }
  async function runOperation(key: string, input: AccountOperation) {
    active();
    input = { ...input, operationKey: requestKey(key) };
    if (input.kind === 'transfer-acceptance') denied();
    const context = 'authorization' in input ? await approved(input) : undefined;
    if (!context) await access.authorizeUnprotectedOperation?.(input);
    const id = workflowId(`operation:${key}`);
    // The stored result is private to the caller whose approval started it. The
    // approval's binding names the actor and the logical operation, and the
    // approval itself carries the principal assignment, so another caller's
    // approval of the same operation under the same key is a different request.
    const digest = hash([
      businessOperation(input),
      context ? (access.approvalBinding?.(context)?.commandKeyPrefix ?? null) : null,
    ]);
    const row = (
      await database.query<{ digest: Buffer }>(
        'INSERT INTO auth_workflow_request (workflow_id,digest,request) VALUES ($1,$2,$3) ON CONFLICT (workflow_id) DO UPDATE SET request=CASE WHEN auth_workflow_request.digest=EXCLUDED.digest THEN EXCLUDED.request ELSE auth_workflow_request.request END RETURNING digest',
        [id, digest, input],
      )
    ).rows[0]!;
    if (!row.digest.equals(digest)) denied();
    const result = await answerOperation(input, async () =>
      (await DBOS.startWorkflow(operation, { workflowID: id })(input)).getResult(),
    );
    // The approval above was resolved once, before any effect. An operation that
    // removes the actor's own standing answers with the workflow's outcome: the
    // actor is not re-authorized against state the operation itself changed.
    // Every other result is disclosed only under current authority.
    if (!(context && removesOwnStanding(input, context))) await discloseUnderCurrentAuthority(input);
    return result;
  }
  /** Auth's failure to delete the sessions of a committed revocation is its own answer. */
  const answerOperation = <T>(input: AccountOperation, work: () => Promise<T>) =>
    input.kind === 'revoke' ? answerRevocation(work) : work();
  async function discloseUnderCurrentAuthority(input: AccountOperation) {
    if ('authorization' in input) await approved(input);
    else await access.authorizeUnprotectedOperation?.(input);
  }
  /** Operations that end the standing their own approval relied on: the account's
   * own deletion, own consent reduction, own session revocation and own leaving of an organization. */
  function removesOwnStanding(input: AccountOperation, context: Context): boolean {
    const actor = access.actorAccountId?.(context);
    if (!actor) return false;
    switch (input.kind) {
      case 'delete':
      case 'consent':
      case 'revoke':
        return input.accountId === actor;
      case 'membership':
        return input.role === null && input.memberAccountId === actor;
      default:
        return false;
    }
  }
  async function waitClientReduction(id: string): Promise<{ clientId: string }> {
    const progress = (
      await database.query<{ client_id: string; completed: boolean; page_after: string }>(
        'SELECT client_id,completed,page_after FROM auth_client_reduction_progress WHERE operation_id=$1',
        [id],
      )
    ).rows[0];
    if (progress?.completed) return { clientId: progress.client_id };
    if (progress?.page_after) id = `${id}:page:${hash(progress.page_after).toString('hex')}`;
    while (true) {
      const status = await DBOS.getWorkflowStatus(id);
      let result: ReductionResult;
      if (status?.status === 'ERROR') {
        const failed = required((await DBOS.listWorkflowSteps(id))?.find((s) => s.error !== null));
        result = await (await DBOS.rewindWorkflow<ReductionResult>(id, { startStep: failed.functionID })).getResult();
      } else result = await DBOS.retrieveWorkflow<ReductionResult>(id).getResult();
      if (!result.nextWorkflowId) return { clientId: result.clientId };
      id = result.nextWorkflowId;
    }
  }
  async function resumeRequest(id: string, skipInitial = false) {
    active();
    const input = required(
      (
        await database.query<{ request: AccountOperation }>(
          'SELECT request FROM auth_workflow_request WHERE workflow_id=$1',
          [id],
        )
      ).rows[0],
    ).request;
    if (!skipInitial) {
      if ('authorization' in input) await approved(input);
      else await access.authorizeUnprotectedOperation?.(input);
    }
    if (input.kind === 'client-reduction') return waitClientReduction(id);
    const status = await DBOS.getWorkflowStatus(id);
    // A committed revocation's cleanup runs under its continuation. Its answer repeats the request's own account,
    // so the person whose sessions it just deleted receives it without standing.
    const disclose = () =>
      skipInitial && input.kind === 'revoke' ? Promise.resolve() : discloseUnderCurrentAuthority(input);
    if (status?.status === 'ERROR') {
      const steps = required(await DBOS.listWorkflowSteps(id));
      const failed = required(steps.find((step) => step.error !== null));
      // Official SDK rewind preserves successful Access barriers and reruns
      // only the failed effect under the exact same workflow/command keys.
      const result = await answerOperation(input, async () =>
        (await DBOS.rewindWorkflow(id, { startStep: failed.functionID })).getResult(),
      );
      await disclose();
      return result;
    }
    const result = await answerOperation(input, async () => (await DBOS.resumeWorkflow(id)).getResult());
    await disclose();
    return result;
  }
  const close = async () => {
    await starting;
    if (!started || owner !== token) return;
    started = false;
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    try {
      await DBOS.shutdown({ deregister: true });
    } finally {
      owner = undefined;
      registered = false;
    }
  };
  const interrupt = () => {
    void close();
  };
  const start = async () => {
    if (owner) throw new Error('Another Auth workflow host owns DBOS in this process');
    owner = token;
    try {
      if (!registered) {
        register();
        options.registerWorkflows?.();
      }
      DBOS.setConfig({
        name: AUTH_WORKFLOW_APPLICATION,
        systemDatabaseUrl: options.systemDatabaseUrl,
        systemDatabaseSchemaName: systemSchema,
        ...(options.systemDatabasePool ? { systemDatabasePool: options.systemDatabasePool } : {}),
        executorID: options.executorId ?? 'auth-accounts',
        applicationVersion: 'accounts-v1',
        systemDatabasePoolSize: 8,
        logLevel: 'warn',
      });
      await DBOS.launch();
      if (sameDatabase) await installWorkflowRequestRetention(database);
      started = true;
      if (options.handleSignals !== false) {
        process.once('SIGINT', interrupt);
        process.once('SIGTERM', interrupt);
      }
    } catch (error) {
      await DBOS.shutdown({ deregister: true });
      owner = undefined;
      registered = false;
      throw error;
    }
  };
  async function authorizeOperatorOpening(input: {
    key: string;
    authorization: string;
    operatorAccountId: string;
    subjectAccountId: string;
  }) {
    active();
    const key = requestKey(input.key);
    const request = {
      kind: 'opening' as const,
      operationKey: key,
      authorization: input.authorization,
      operatorAccountId: input.operatorAccountId,
      subjectAccountId: input.subjectAccountId,
    };
    const context = await approved(request);
    const approval = await required(access.authorizeOpening)(context, {
      operatorAccountId: input.operatorAccountId,
      subjectAccountId: input.subjectAccountId,
      purpose: 'session',
      key: access.stableCommandKey?.(context, 'session-opening') ?? `session:${hash(key).toString('hex')}`,
    });
    // The workflow ends at the replayable Access receipt. Only Auth issuance
    // consumes it; cookies and session responses never become workflow results.
    return approval.value;
  }
  return {
    start() {
      if (started) return Promise.resolve();
      return (starting ??= start().finally(() => {
        starting = undefined;
      }));
    },
    close,
    beginRegistration: (input: { key: string; handle: string }) => begin(input),
    installRegistrationCredential: install,
    activateRegistration,
    async register(input: { key: string; handle: string; email: string; password: string }) {
      const ref = await begin(input, input);
      await install({ ...input, registrationId: ref.registrationId });
      return activateRegistration(ref.registrationId);
    },
    async expireDueRegistrations() {
      active();
      let afterExpiry = '-infinity';
      let afterId = '';
      while (true) {
        const rows = (
          await database.query<Stage & { due_expires_at: string }>(
            'SELECT registration_id,request_key,handle,account_id,reservation_id,expires_at,completed_at,expired_at,expires_at::text AS due_expires_at FROM auth_registration_stage WHERE completed_at IS NULL AND expired_at IS NULL AND expires_at<=$1 AND (expires_at,registration_id)>($2::timestamptz,$3) ORDER BY expires_at,registration_id LIMIT 64',
            [now(), afterExpiry, afterId],
          )
        ).rows;
        for (const row of rows) {
          const automated = (
            await database.query<{ workflow_id: string }>(
              "SELECT workflow_id FROM auth_workflow_request WHERE request->>'kind'='automated' AND request->>'registrationId'=$1",
              [row.registration_id],
            )
          ).rows[0];
          if (automated) {
            await resumeRequest(automated.workflow_id);
            continue;
          }
          const ref = reference(row);
          await DBOS.send(ref.workflowId, 'expire', 'credential', `${ref.workflowId}:expire-credential`);
          await DBOS.send(ref.workflowId, 'expire', 'activation', `${ref.workflowId}:expire-activation`);
          const status = await DBOS.getWorkflowStatus(ref.workflowId);
          if (status?.status === 'ERROR') {
            const failed = required(
              (await DBOS.listWorkflowSteps(ref.workflowId))?.find((step) => step.error !== null),
            );
            await (await DBOS.rewindWorkflow(ref.workflowId, { startStep: failed.functionID })).getResult();
          } else await DBOS.retrieveWorkflow(ref.workflowId).getResult();
        }
        if (rows.length < 64) return;
        afterExpiry = rows.at(-1)!.due_expires_at;
        afterId = rows.at(-1)!.registration_id;
      }
    },
    revokeSessions: (input: Command & { authorization?: string }) =>
      runOperation(input.key, {
        kind: 'revoke',
        accountId: input.accountId,
        ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
      }),
    renameHandle: (input: {
      key: string;
      authorization: string;
      accountId: string;
      handle: string;
      expectedHandle: string | null;
    }) =>
      runOperation(input.key, {
        kind: 'rename',
        accountId: input.accountId,
        handle: normalized(input.handle),
        expectedHandle: input.expectedHandle === null ? null : normalizedLookup(input.expectedHandle),
        authorization: input.authorization,
      }),
    createOrganization: (input: { key: string; authorization: string; handle: string }) =>
      runOperation(input.key, {
        kind: 'organization',
        handle: normalized(input.handle),
        authorization: input.authorization,
      }),
    setMembership: (input: Omit<Extract<AccountOperation, { kind: 'membership' }>, 'kind'> & { key: string }) => {
      if (input.role === null && !input.reservationId) denied();
      return runOperation(input.key, {
        kind: 'membership',
        authorization: input.authorization,
        organizationId: input.organizationId,
        memberAccountId: input.memberAccountId,
        role: input.role,
        ...(input.reservationId ? { reservationId: input.reservationId } : {}),
      });
    },
    async createAutomated(input: {
      key: string;
      authorization: string;
      operatorAccountId: string;
      handle: string;
      credential?: { email: string; password: string };
    }) {
      active();
      requestKey(input.key);
      const request = {
        kind: 'automated' as const,
        registrationId: '',
        authorization: input.authorization,
        operatorAccountId: input.operatorAccountId,
        handle: normalized(input.handle),
        operationKey: requestKey(input.key),
      };
      await required(access.authorizeOperation)(input.authorization, { ...request, registrationId: '' });
      const row = await createStage(
        { key: `automated:${hash(input.key).toString('hex')}`, handle: input.handle },
        input.credential,
        request,
      );
      return runOperation(input.key, { ...request, registrationId: row.registration_id });
    },
    transferOperator: (input: Omit<Extract<AccountOperation, { kind: 'transfer' }>, 'kind'> & { key: string }) => {
      return runOperation(input.key, {
        kind: 'transfer',
        authorization: input.authorization,
        previous: responsibility(input.previous),
        expectedVersion: input.expectedVersion,
        operatorAccountId: input.operatorAccountId,
        ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
      });
    },
    deleteAccount: (input: Omit<Extract<AccountOperation, { kind: 'delete' }>, 'kind'> & { key: string }) => {
      return runOperation(input.key, {
        kind: 'delete',
        authorization: input.authorization,
        accountId: input.accountId,
        ...(input.responsibility ? { responsibility: responsibility(input.responsibility) } : {}),
      });
    },
    fenceOperator: async (
      input: Omit<Extract<AccountOperation, { kind: 'fence-operator' }>, 'kind'> & { key: string },
    ) => {
      const result = await runOperation(input.key, {
        kind: 'fence-operator',
        authorization: input.authorization,
        accountId: input.accountId,
      });
      if (!('state' in result)) denied();
      return result;
    },
    reduceConsent: (input: Omit<Extract<AccountOperation, { kind: 'consent' }>, 'kind'> & { key: string }) => {
      return runOperation(input.key, {
        kind: 'consent',
        authorization: input.authorization,
        accountId: input.accountId,
        clientId: input.clientId,
        scopes: [...input.scopes],
      });
    },
    async reduceClientScopes(
      input: Omit<Extract<AccountOperation, { kind: 'client-reduction' }>, 'kind'> & { key: string },
    ) {
      active();
      const key = requestKey(input.key);
      const operation = {
        kind: 'client-reduction' as const,
        operationKey: key,
        authorization: input.authorization,
        clientId: input.clientId,
        firstParty: input.firstParty,
        scopes: [...input.scopes],
      };
      await approved(operation);
      const id = workflowId(`client-reduction:${key}`);
      const digest = hash(operation);
      const row = (
        await database.query<{ digest: Buffer }>(
          'INSERT INTO auth_workflow_request (workflow_id,digest,request) VALUES ($1,$2,$3) ON CONFLICT (workflow_id) DO UPDATE SET request=CASE WHEN auth_workflow_request.digest=EXCLUDED.digest THEN EXCLUDED.request ELSE auth_workflow_request.request END RETURNING digest',
          [id, digest, operation],
        )
      ).rows[0]!;
      if (!row.digest.equals(digest)) denied();
      await DBOS.startWorkflow(clientReduction, { workflowID: id })(operation);
      return waitClientReduction(id);
    },
    authorizeOperatorOpening,
    async openOperatorSession(input: {
      key: string;
      authorization: string;
      operatorAccountId: string;
      subjectAccountId: string;
      headers: Headers;
    }) {
      const opening = await authorizeOperatorOpening(input);
      // Immediate HTTP composition retains fail-closed issuance on a retry.
      return auth.internal.openAutomatedSession({
        authorization: opening.receiptId,
        subjectAccountId: input.subjectAccountId,
        headers: input.headers,
      });
    },
    resumeOperation: async (key: string) => {
      const operationKey = requestKey(key);
      const id = workflowId(`operation:${operationKey}`);
      if (access.readContinuation) {
        const stored = (
          await database.query<{ request: AccountOperation }>(
            'SELECT request FROM auth_workflow_request WHERE workflow_id=$1',
            [id],
          )
        ).rows[0]?.request;
        // A protected revocation commits a continuation; a callback-only host's unprotected one does not.
        const continuing = stored?.kind === 'delete' || (stored?.kind === 'revoke' && 'authorization' in stored);
        if (continuing && (await access.readContinuation(operationKey, stored.accountId)))
          return resumeRequest(id, true);
      }
      return resumeRequest(id);
    },
    resumeClientReduction: (key: string) => resumeRequest(workflowId(`client-reduction:${requestKey(key)}`)),
    async handler(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== '/signup') return auth.handler(request);
      const response = (value: unknown, status: number) =>
        Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
      if (
        request.method !== 'POST' ||
        url.search ||
        request.headers.get('origin') !== new URL(auth.verifier.issuer).origin ||
        request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
      )
        return response({ error: 'registration_denied' }, 400);
      try {
        const reader = request.body?.getReader();
        if (!reader) return response({ error: 'registration_denied' }, 400);
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 16384) return response({ error: 'registration_denied' }, 400);
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel();
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return response({ error: 'registration_denied' }, 400);
        }
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).some((field) => !['key', 'handle', 'email', 'password', 'turnstile_token'].includes(field))
        )
          return response({ error: 'registration_denied' }, 400);
        const input = body as Record<string, unknown>;
        if (
          ['key', 'handle', 'email', 'password', 'turnstile_token'].some((field) => typeof input[field] !== 'string') ||
          !(input.key as string) ||
          (input.key as string).length > 128 ||
          !isClaimHandle(input.handle) ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email as string) ||
          (input.email as string).length > 254 ||
          (input.password as string).length < 8 ||
          (input.password as string).length > 128 ||
          !(input.turnstile_token as string) ||
          (input.turnstile_token as string).length > 4096
        )
          return response({ error: 'registration_denied' }, 400);
        if (!options.turnstile) return response({ error: 'registration_denied' }, 503);
        let verified: boolean;
        const remoteIp = sanitizedClientIp(request);
        try {
          verified = await verifyTurnstile(options.turnstile, {
            token: input.turnstile_token as string,
            hostname: new URL(auth.verifier.issuer).hostname,
            ...(remoteIp ? { remoteIp } : {}),
          });
        } catch {
          return response({ error: 'registration_denied' }, 503);
        }
        if (!verified) return response({ error: 'registration_denied' }, 400);
        try {
          const ref = await begin(
            { key: input.key as string, handle: input.handle as string },
            { email: input.email as string, password: input.password as string },
          );
          await install({
            registrationId: ref.registrationId,
            email: input.email as string,
            password: input.password as string,
          });
          return response(await activateRegistration(ref.registrationId), 201);
        } catch (error) {
          if (error instanceof RegistrationFailure) return response({ error: error.code }, 409);
        }
        return response({ error: 'registration_denied' }, 503);
      } catch {
        return response({ error: 'registration_denied' }, 503);
      }
    },
  };
}
