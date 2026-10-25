import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import type { AuthService } from './index.ts';

/** Transport-neutral shapes of the existing Access command inputs/results.
 * Production ports return the complete native CommandOutcome, including receipt
 * position/transactionId. The coordinator consumes only its nonsecret value. */
type Result<T> = Promise<{ value: T }>;
type Command = { accountId: string; key: string };
export type WorkflowHandleTransition = Command & {
  handle: string;
  expectedHandle: string | null;
  reservationId: string;
  operationId: string;
};
export type WorkflowContext = { actor: { accountId: string } };
type Reservation = { handle: string; accountId: string; reservationId: string; expiresAt: string };
export type WorkflowFence = {
  accountId: string;
  receiptId: string;
  minimumAuthnEpoch: string;
  kind: string;
  priorOperatorAccountId: string | null;
};
export type AccountOperation =
  | { kind: 'rename'; accountId: string; handle: string; expectedHandle: string | null; authorization: string }
  | { kind: 'organization'; handle: string; authorization: string }
  | { kind: 'revoke'; accountId: string };

export interface AccountWorkflowPorts<Context = WorkflowContext> {
  registrationTarget(key: string): string;
  reserveHandle(input: { handle: string; accountId: string; key: string }): Result<Reservation>;
  createPending(
    input: Command & { handle: string; reservationId: string },
  ): Result<{ accountId: string; registrationId: string; expiresAt: string }>;
  claimHandle(
    input: Command & { handle: string; reservationId: string; evidence?: unknown },
  ): Result<{ accountId: string; handle: string }>;
  activate(input: Command & { evidence: unknown }): Result<{ accountId: string }>;
  expireRegistration(input: Command & { handle: string; reservationId: string }): Result<unknown>;
  releaseExpiredRegistrationHandle(input: Command & { handle: string; reservationId: string }): Result<unknown>;
  provisioningReference(input: { accountId: string; reservationId: string }): Promise<string>;
  provisioningEvidence(input: { accountId: string; reservationId: string }): Promise<unknown>;
  raiseFence(input: Command): Result<WorkflowFence>;
  /** Resolve a durable approval to an authenticated kernel context. Recheck
   * current authorization; never synthesize a context from public JSON. Called
   * inside each protected step, so context/private facts never enter DBOS. */
  authorizeOperation?(reference: string, operation: AccountOperation): Promise<Context>;
  actorAccountId?(context: Context): string;
  holdHandle?(input: WorkflowHandleTransition): Result<unknown>;
  transitionAccountHandle?(context: Context, input: WorkflowHandleTransition): Result<unknown>;
  finalizeHandleTransition?(input: WorkflowHandleTransition): Result<unknown>;
  redirectTransitionHandle?(input: WorkflowHandleTransition): Result<unknown>;
  completeHandleTransition?(input: WorkflowHandleTransition): Result<unknown>;
  cancelHandleTransition?(input: WorkflowHandleTransition): Result<unknown>;
  releaseHandleTransition?(input: WorkflowHandleTransition): Result<unknown>;
  reserveCoordination?(
    input: Command & { relatedAccountId: string; purpose: 'membership' | 'operator' },
  ): Result<{ accountId: string; relatedAccountId: string; purpose: string; reservationId: string }>;
  createOrganization?(input: {
    organizationId: string;
    ownerAccountId: string;
    ownerReservationId: string;
    key: string;
  }): Result<{ accountId: string; ownerAccountId: string }>;
  bootstrapOrganizationHandle?(
    input: WorkflowHandleTransition & { ownerAccountId: string; ownerReservationId: string },
  ): Result<unknown>;
}
export interface AccountWorkflowOptions<Context = WorkflowContext> {
  database: Pool;
  systemDatabaseUrl: string;
  /** Persistent Auth-only 32-byte key, independent of Better Auth/signing keys. */
  stagingKey: Uint8Array;
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
let owner: object | undefined;
function denied(): never {
  throw new Error('Account workflow denied');
}
function required<T>(value: T | null | undefined): T {
  if (value == null) denied();
  return value;
}
function normalized(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) denied();
  return value.toLowerCase();
}
function requestKey(value: string) {
  if (typeof value !== 'string' || !value || value.length > 128) denied();
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest();
const workflowId = (key: string) => `accounts:${hash(key).toString('hex')}`;

/** One explicit Auth application owns DBOS. createAuthService has no global
 * executor side effects. Do not create two workflow hosts in one process. */
export function createAccountWorkflows<Context = WorkflowContext>(options: AccountWorkflowOptions<Context>) {
  const { database, auth, access } = options;
  if (options.stagingKey.byteLength !== 32) throw new Error('Configure a persistent 32-byte Auth staging key');
  if (
    !options.systemDatabaseUrl ||
    (new URL(options.systemDatabaseUrl).pathname === new URL(database.options.connectionString!).pathname &&
      new URL(options.systemDatabaseUrl).host === new URL(database.options.connectionString!).host)
  )
    throw new Error('DBOS requires a separate system database');
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
  async function createStage(input: { key: string; handle: string }, credential?: { email: string; password: string }) {
    const request = requestKey(input.key);
    const handle = normalized(input.handle);
    const digest = hash([handle]);
    const id = randomBytes(24).toString('base64url');
    const accountId = access.registrationTarget(request);
    const sealed = credential ? sealCredential(id, accountId, handle, credential) : null;
    const result = await database.query<Stage & { request_digest: Buffer; credential_digest: Buffer | null }>(
      'INSERT INTO auth_registration_stage (registration_id,request_key,handle,account_id,request_digest,ciphertext,credential_digest) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *',
      [id, request, handle, accountId, digest, sealed?.ciphertext ?? null, sealed?.digest ?? null],
    );
    const row = required(result.rows[0]);
    if (
      !row.request_digest.equals(digest) ||
      row.account_id !== accountId ||
      (sealed && !row.credential_digest?.equals(sealed.digest))
    )
      denied();
    return row;
  }
  async function approved(input: AccountOperation): Promise<Context> {
    if (!('authorization' in input)) denied();
    return required(access.authorizeOperation)(input.authorization, input);
  }
  const commandKey = (phase: string) => `wf:${required(DBOS.workflowID)}:${phase}`;
  const step = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    DBOS.registerStep(
      async (...args: A) => {
        try {
          return await fn(...args);
        } catch {
          throw new Error(`Account workflow step failed: ${name}`);
        }
      },
      { name: `accounts.${name}`, retriesAllowed: false },
    );

  // Functions are registered on start, and recreated after a clean SDK shutdown.
  let registration: (input: RegistrationInput) => Promise<{ accountId: string; expired?: true }>;
  let operation: (input: AccountOperation) => Promise<{ accountId: string }>;
  function register() {
    const read = step('read-registration', stage);
    const reserve = step(
      'reserve-handle',
      async (row: Stage) =>
        (
          await access.reserveHandle({
            handle: row.handle,
            accountId: row.account_id,
            key: commandKey('reserve-handle'),
          })
        ).value,
    );
    const pending = step('pending-account', async (claim: Reservation, id: string) => {
      const result = await access.createPending({ ...claim, key: commandKey('pending-account') });
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
    const provision = step('install-credential', async (id: string) => {
      const row = await stage(id);
      if (row.expired_at || required(row.expires_at).getTime() <= now().getTime())
        return { accountId: row.account_id, expired: true as const };
      const authorization = await access.provisioningReference({
        accountId: row.account_id,
        reservationId: required(row.reservation_id),
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
        return await auth.internal.provisionPassword({
          authorization,
          ...credential,
          idempotencyKey: `registration:${id}`,
        });
      } finally {
        clear.fill(0);
      }
    });
    const evidence = step('provisioning-evidence', async (claim: Reservation) => access.provisioningEvidence(claim));
    const claimHandle = step('claim-handle', async (claim: Reservation, proof: unknown, id: string) => {
      try {
        return (await access.claimHandle({ ...claim, evidence: proof, key: commandKey('claim-handle') })).value;
      } catch {
        const row = await stage(id);
        if (required(row.expires_at).getTime() <= now().getTime())
          return { accountId: row.account_id, expired: true as const };
        throw new Error('Handle barrier unavailable');
      }
    });
    const activate = step('activate-account', async (accountId: string, proof: unknown, id: string) => {
      try {
        // A committed activation receipt wins on replay, even past the pending
        // deadline. An uncommitted activation still uses Access's original TTL.
        return (await access.activate({ accountId, evidence: proof, key: commandKey('activate') })).value;
      } catch {
        const row = await stage(id);
        if (required(row.expires_at).getTime() <= now().getTime()) return { accountId, expired: true as const };
        throw new Error('Activation unavailable');
      }
    });
    const complete = step('registration-complete', async (id: string) => {
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
    const erase = step('erase-auth-owner', async (accountId: string) => auth.internal.eraseAccount(accountId));
    const expired = step('registration-terminal', async (id: string) => {
      await database.query(
        'UPDATE auth_registration_stage SET expired_at=$2,ciphertext=NULL WHERE registration_id=$1 AND completed_at IS NULL',
        [id, now()],
      );
    });
    registration = DBOS.registerWorkflow(
      async (input: RegistrationInput) => {
        const row = await read(input.registrationId);
        const claim = await reserve(row);
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
          const installed = await provision(input.registrationId);
          if (!('expired' in installed)) {
            const proof = await evidence(claim);
            const claimed = await claimHandle(claim, proof, input.registrationId);
            if (!('expired' in claimed)) {
              await DBOS.setEvent('credential', { accountId: row.account_id });
              const next = await DBOS.recv<string>('activation', { deadlineEpochMS: Date.parse(claim.expiresAt) });
              if (next !== 'expire' && !(await isExpired(input.registrationId))) {
                const result = await activate(row.account_id, proof, input.registrationId);
                if (!('expired' in result)) {
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
      async (accountId: string) =>
        (await access.raiseFence({ accountId, key: commandKey(`fence:${accountId}`) })).value,
    );
    const revoke = step('revoke-auth-sessions', async (accountId: string) => auth.internal.revokeSessions(accountId));
    const hold = step('hold-new-handle', async (input: WorkflowHandleTransition) => {
      await required(access.holdHandle)({ ...input, key: commandKey('hold-handle') });
    });
    const publish = step('publish-handle', async (input: WorkflowHandleTransition, request: AccountOperation) => {
      await required(access.transitionAccountHandle)(await approved(request), {
        ...input,
        key: commandKey('publish-handle'),
      });
    });
    const finalize = step('finalize-handle', async (input: WorkflowHandleTransition) => {
      await required(access.finalizeHandleTransition)({ ...input, key: commandKey('finalize-handle') });
    });
    const redirect = step('redirect-old-handle', async (input: WorkflowHandleTransition) => {
      await required(access.redirectTransitionHandle)({ ...input, key: commandKey('redirect-handle') });
    });
    const finishHandle = step('complete-handle-operation', async (input: WorkflowHandleTransition) => {
      await required(access.completeHandleTransition)({ ...input, key: commandKey('complete-handle') });
    });
    const reserveOwner = step('reserve-owner', async (input: AccountOperation, organizationId: string) => {
      const context = await approved(input);
      const ownerAccountId = required(access.actorAccountId)(context);
      return (
        await required(access.reserveCoordination)({
          accountId: ownerAccountId,
          relatedAccountId: organizationId,
          purpose: 'membership',
          key: commandKey('reserve-owner'),
        })
      ).value;
    });
    const organization = step(
      'create-organization',
      async (organizationId: string, ownerAccountId: string, ownerReservationId: string) =>
        (
          await required(access.createOrganization)({
            organizationId,
            ownerAccountId,
            ownerReservationId,
            key: commandKey('organization'),
          })
        ).value,
    );
    const bootstrap = step(
      'bootstrap-organization-handle',
      async (input: WorkflowHandleTransition, ownerAccountId: string, ownerReservationId: string) => {
        await required(access.bootstrapOrganizationHandle)({
          ...input,
          ownerAccountId,
          ownerReservationId,
          key: commandKey('bootstrap-handle'),
        });
      },
    );
    operation = DBOS.registerWorkflow(
      async (input: AccountOperation) => {
        if (input.kind === 'revoke') {
          await fence(input.accountId);
          await revoke(input.accountId);
          return { accountId: input.accountId };
        }
        if (input.kind === 'rename' || input.kind === 'organization') {
          const accountId =
            input.kind === 'rename' ? input.accountId : access.registrationTarget(commandKey('organization-id'));
          const owner = input.kind === 'organization' ? await reserveOwner(input, accountId) : null;
          if (owner) await organization(accountId, owner.accountId, owner.reservationId);
          const claim = await reserve({ account_id: accountId, handle: input.handle } as Stage);
          const transition = {
            accountId,
            handle: claim.handle,
            reservationId: claim.reservationId,
            expectedHandle: input.kind === 'rename' ? input.expectedHandle : null,
            operationId: required(DBOS.workflowID),
            key: commandKey('transition'),
          };
          await hold(transition);
          if (owner) await bootstrap(transition, owner.accountId, owner.reservationId);
          else await publish(transition, input);
          await finalize(transition);
          if (transition.expectedHandle !== null) await redirect(transition);
          await finishHandle(transition);
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
    return required(
      await DBOS.getEvent<RegistrationReference>(workflowId(`registration:${row.request_key}`), 'pending', 30),
    );
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
    if (!changed.rowCount) denied();
    const ref = reference(row);
    await DBOS.send(ref.workflowId, 'install', 'credential', `${ref.workflowId}:install`);
    return required(await DBOS.getEvent<{ accountId: string }>(ref.workflowId, 'credential', 30));
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
    requestKey(key);
    if ('authorization' in input) await approved(input);
    const id = workflowId(`operation:${key}`);
    const digest = hash(input);
    const row = (
      await database.query<{ digest: Buffer }>(
        'INSERT INTO auth_workflow_request (workflow_id,digest,request) VALUES ($1,$2,$3) ON CONFLICT (workflow_id) DO UPDATE SET workflow_id=EXCLUDED.workflow_id RETURNING digest',
        [id, digest, input],
      )
    ).rows[0]!;
    if (!row.digest.equals(digest)) denied();
    return (await DBOS.startWorkflow(operation, { workflowID: id })(input)).getResult();
  }
  const close = async () => {
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
  return {
    async start() {
      if (started) return;
      if (owner) throw new Error('Another Auth workflow host owns DBOS in this process');
      owner = token;
      try {
        if (!registered) register();
        DBOS.setConfig({
          name: 'rezics-auth-accounts',
          systemDatabaseUrl: options.systemDatabaseUrl,
          executorID: options.executorId ?? 'auth-accounts',
          applicationVersion: 'accounts-v1',
          systemDatabasePoolSize: 8,
          logLevel: 'warn',
        });
        await DBOS.launch();
        started = true;
        process.once('SIGINT', interrupt);
        process.once('SIGTERM', interrupt);
      } catch (error) {
        await DBOS.shutdown({ deregister: true });
        owner = undefined;
        registered = false;
        throw error;
      }
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
      let after = '';
      while (true) {
        const rows = (
          await database.query<Stage>(
            'SELECT registration_id,request_key,handle,account_id,reservation_id,expires_at,completed_at,expired_at FROM auth_registration_stage WHERE completed_at IS NULL AND expired_at IS NULL AND expires_at<=$1 AND registration_id>$2 ORDER BY registration_id LIMIT 64',
            [now(), after],
          )
        ).rows;
        for (const row of rows) {
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
        after = rows.at(-1)!.registration_id;
      }
    },
    revokeSessions: (input: Command) => runOperation(input.key, { kind: 'revoke', accountId: input.accountId }),
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
        expectedHandle: input.expectedHandle === null ? null : normalized(input.expectedHandle),
        authorization: input.authorization,
      }),
    createOrganization: (input: { key: string; authorization: string; handle: string }) =>
      runOperation(input.key, {
        kind: 'organization',
        handle: normalized(input.handle),
        authorization: input.authorization,
      }),
    async resumeOperation(key: string) {
      active();
      const id = workflowId(`operation:${requestKey(key)}`);
      const input = required(
        (
          await database.query<{ request: AccountOperation }>(
            'SELECT request FROM auth_workflow_request WHERE workflow_id=$1',
            [id],
          )
        ).rows[0],
      ).request;
      if ('authorization' in input) await approved(input);
      const status = await DBOS.getWorkflowStatus(id);
      if (status?.status === 'ERROR') {
        const steps = required(await DBOS.listWorkflowSteps(id));
        const failed = required(steps.find((step) => step.error !== null));
        // Official SDK rewind preserves successful Access barriers and reruns
        // only the failed effect under the exact same workflow/command keys.
        return (await DBOS.rewindWorkflow(id, { startStep: failed.functionID })).getResult();
      }
      return (await DBOS.resumeWorkflow(id)).getResult();
    },
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
            if (size > 16384) return response({ error: 'registration_denied' }, 413);
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel();
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).some((field) => !['key', 'handle', 'email', 'password'].includes(field))
        )
          return response({ error: 'registration_denied' }, 400);
        const input = body as Record<string, unknown>;
        if (['key', 'handle', 'email', 'password'].some((field) => typeof input[field] !== 'string'))
          return response({ error: 'registration_denied' }, 400);
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
      } catch {
        return response({ error: 'registration_denied' }, 503);
      }
    },
  };
}
