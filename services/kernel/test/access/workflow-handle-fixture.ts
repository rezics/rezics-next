import { DBOS } from '@dbos-inc/dbos-sdk';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { Pool } from 'pg';
import type { JWK } from 'jose';
import { createAuthService, createAccountWorkflows } from '../../../auth/src/index.ts';
import type { AccountWorkflowPorts, AccountOperation } from '../../../auth/src/workflows.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/index.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  type LifecycleRequest,
} from '../../src/access/lifecycle.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import { accessCheck } from '../../src/request/access.ts';
import { AuthBindingDeniedError } from '../../src/access/auth-bindings.ts';
import { createCommittedContinuations } from '../../src/access/committed-continuations.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
import { nativeReceiptKeyCandidates } from '../../src/command/receipt-key.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { type Pending } from '../../src/history/contract/identity-types.ts';

export type FixtureConfiguration = {
  kernelUrl: string;
  authUrl: string;
  systemUrl: string;
  stagingKey: string;
  secret: string;
  signing: JWK;
};
export async function handleFixture(
  config: FixtureConfiguration,
  clock = () => new Date(),
  afterCredential?: (accountId: string, registrationId: string) => Promise<void>,
) {
  // A single resource connection also detects accidental simultaneous anchor checkout.
  const kernel = createPool(config.kernelUrl);
  configureTestReceiptKeys(kernel);
  kernel.options.max = 1;
  const database = new Pool({ connectionString: config.authUrl });
  const read = (id: string) => withConnection(kernel, (client) => readAccount(client, routeOf(id)!, id));
  async function pendingProof(reference: string) {
    const row = (
      await database.query<{ account_id: string; reservation_id: string; request_key: string }>(
        'SELECT account_id,reservation_id,request_key FROM auth_registration_stage WHERE registration_id=$1',
        [reference],
      )
    ).rows[0];
    if (!row?.reservation_id) throw new Error('No durable pending registration');
    const route = routeOf(row.account_id)!;
    const automated = (
      await database.query<{ workflow_id: string; request: Extract<AccountOperation, { kind: 'automated' }> }>(
        "SELECT workflow_id,request FROM auth_workflow_request WHERE request->>'kind'='automated' AND request->>'registrationId'=$1",
        [reference],
      )
    ).rows[0];
    const workflow =
      automated?.workflow_id ??
      `accounts:${createHash('sha256')
        .update(JSON.stringify(`registration:${row.request_key}`))
        .digest('hex')}`;
    const prefix = automated
      ? `wf:${createHash('sha256')
          .update(
            canonicalize([automated.request.operatorAccountId, automated.request.authorization, automated.request])!,
          )
          .digest('hex')}`
      : `wf:${workflow}`;
    const receipt = await kernel.query<{ response: { accountId: string; registrationId: string } }>(
      "SELECT response FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND command_kind='access.actor-pending' AND idempotency_key=ANY($3::text[])",
      [
        partitionOf(route),
        '00000000-0000-8000-8000-000000000001',
        nativeReceiptKeyCandidates(
          kernel,
          'access.actor-pending',
          '00000000-0000-8000-8000-000000000001',
          `${route}:${prefix}:pending-account`,
        ),
      ],
    );
    if (
      receipt.rows[0]?.response.accountId !== row.account_id ||
      receipt.rows[0]?.response.registrationId !== row.reservation_id
    )
      throw new Error('Pending receipt mismatch');
    return row;
  }
  const internal = createLifecycleInternals({
    pool: kernel,
    clock,
    routeKey: createHash('sha256').update('durable-handle-fixture-route').digest(),
    async provisioningEvidence(proof) {
      if (typeof proof !== 'string') return null;
      const row = await pendingProof(proof);
      const owner = await database.query('SELECT id FROM "user" WHERE id=$1', [row.account_id]);
      if (!owner.rowCount) return null;
      return {
        accountId: row.account_id,
        registrationId: row.reservation_id,
        authIdentityId: row.account_id,
        authnEpoch: 1,
      };
    },
    recoveryEvidence: async () => null,
  });
  const openings = new Map<string, LifecycleRequest>();
  let operators: ReturnType<typeof createOperatorCommands>;
  const auth = await createAuthService({
    database,
    issuer: 'https://durable-handles.auth.test',
    audience: 'https://durable-handles.api.test',
    secret: config.secret,
    signing: { activeKid: config.signing.kid!, privateKeys: [config.signing] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const account = await read(id);
        return account
          ? {
              accountId: id,
              kind: account.kind as 'actor' | 'organization',
              state: account.state as 'pending' | 'active' | 'suspended' | 'deleted',
              authnEpoch: Number(account.minimumAuthnEpoch),
              automated: account.operatorAccountId !== null,
              fenced: account.fenced,
            }
          : null;
      },
      authorizeProvisioning: async (reference) => ({ accountId: (await pendingProof(reference)).account_id }),
      async consumeAuthorization(input) {
        const context = openings.get(input.authorization);
        if (
          !context ||
          input.purpose !== 'session' ||
          context.actor.accountId !== input.human.account_id ||
          context.actor.clientId !== input.human.client_id ||
          context.actor.authnEpoch !== input.human.authn_epoch
        )
          throw new Error('Opening human mismatch');
        const subject = await read(input.subjectAccountId);
        if (!subject?.operatorAccountId) throw new Error('Missing operator');
        const result = await operators.consumeOpening(context, {
          operatorAccountId: subject.operatorAccountId,
          subjectAccountId: input.subjectAccountId,
          receiptId: input.authorization,
          purpose: 'session',
          key: `consume:${input.authorization}`,
        });
        return {
          ...result.value,
          purpose: 'session',
          humanEpoch: input.human.authn_epoch,
          subjectEpoch: Number(subject.minimumAuthnEpoch),
        };
      },
    }),
  });
  await auth.internal.registerClient({
    clientId: 'durable-web',
    firstParty: true,
    scopes: ['account:update', 'account:delete', 'organization:create', 'organization:membership', 'account:manage'],
  });
  const actions = new Map([
    ...LIFECYCLE_ACTIONS,
    ['account:manage', { anonymous: false }],
    ['organization:create', { anonymous: false }],
  ] as const);
  const access = createAccess({
    actions,
    auth: {
      ...auth.verifier,
      fetch: async () => auth.handler(new Request(auth.verifier.jwksUrl)),
    },
  });
  const commands = createLifecycleCommands({ pool: kernel, access });
  const continuations = createCommittedContinuations({
    pool: kernel,
    access,
    referenceKeys: { current: 1, keys: new Map([[1, Buffer.from(config.stagingKey, 'hex')]]) },
    clock,
  });
  operators = createOperatorCommands({ pool: kernel, access, actions, managementAction: 'account:manage' });
  const approvals = new Map<string, { token: string; operation?: AccountOperation }>();
  const commandKeyPrefixes = new WeakMap<object, string>();
  const operationDigests = new WeakMap<object, string>();
  let fault: string | undefined;
  let beforeRevoke: ((accountId: string) => Promise<void>) | undefined;
  const effects: { phase: string; transactionId: string; replayed: boolean }[] = [];
  function intercept<T extends (...args: never[]) => Promise<{ transactionId: string; replayed: boolean }>>(
    phase: string,
    fn: T,
  ): T {
    return (async (...args: Parameters<T>) => {
      const result = await fn(...args);
      effects.push({ phase, transactionId: result.transactionId, replayed: result.replayed });
      if (fault === phase) {
        fault = undefined;
        throw new Error('Lost command acknowledgement');
      }
      return result;
    }) as T;
  }
  const ports: AccountWorkflowPorts<LifecycleRequest> = {
    ...internal,
    ...operators,
    readAccount: read,
    setMembership: commands.setMembership,
    tombstone: commands.tombstone,
    async authorizeOpening(context, input) {
      const result = await operators.authorizeOpening(context, input);
      openings.set(result.value.receiptId, context);
      return result;
    },
    transitionAccountHandle: commands.transitionAccountHandle,
    async provisioningReference({ accountId, reservationId }) {
      const row = (
        await database.query<{ registration_id: string }>(
          'SELECT registration_id FROM auth_registration_stage WHERE account_id=$1 AND reservation_id=$2',
          [accountId, reservationId],
        )
      ).rows[0];
      if (!row) throw new Error('Missing provisioning reference');
      return row.registration_id;
    },
    async provisioningEvidence(input) {
      return ports.provisioningReference(input);
    },
    async authorizeOperation(reference, operation) {
      const approval = approvals.get(reference);
      if (!approval || (approval.operation && JSON.stringify(approval.operation) !== JSON.stringify(operation)))
        throw new Error('Approval mismatch');
      const context = { pool: kernel, deadline: Date.now() + 5000 };
      const actor = await access.authenticate(approval.token, context).catch(() => {
        throw new AuthBindingDeniedError();
      });
      if (actor.kind !== 'account') throw new Error('No authenticated actor');
      const target =
        operation.kind === 'automated' || operation.kind === 'opening'
          ? operation.operatorAccountId
          : operation.kind === 'transfer'
            ? operation.previous.operatorAccountId
            : operation.kind === 'membership'
              ? operation.organizationId
              : 'accountId' in operation
                ? operation.accountId
                : null;
      const action =
        operation.kind === 'automated' || operation.kind === 'opening' || operation.kind === 'transfer'
          ? 'account:manage'
          : operation.kind === 'membership'
            ? 'organization:membership'
            : operation.kind === 'delete'
              ? 'account:delete'
              : 'account:update';
      if (target && operation.kind !== 'revoke') {
        const check = await accessCheck(access, actor, action, { route: routeOf(target)!, id: target }, context);
        if (!(await withConnection(kernel, (client) => check(client))))
          throw new Error('Current operation authorization denied');
      }
      const approved = { ...context, actor, account: await read(actor.accountId) };
      commandKeyPrefixes.set(
        approved,
        `wf:${createHash('sha256')
          .update(canonicalize([actor.accountId, reference, operation])!)
          .digest('hex')}`,
      );
      operationDigests.set(approved, createHash('sha256').update(canonicalize(operation)!).digest('hex'));
      return approved;
    },
    actorAccountId: (context) => context.actor.accountId,
    stableCommandKey(context, phase) {
      const prefix = commandKeyPrefixes.get(context);
      if (!prefix) throw new Error('Workflow command key requires an approved operation');
      return `${prefix}:${phase}`;
    },
    approvalBinding(context) {
      const commandKeyPrefix = commandKeyPrefixes.get(context);
      const digest = operationDigests.get(context);
      return commandKeyPrefix && digest ? { operationKey: digest, digest, commandKeyPrefix } : undefined;
    },
    readContinuation: (key, accountId) => continuations.read(key, accountId),
    authorizeContinuation: (reference, entry) => continuations.authorizeStep(reference, entry),
  };
  const native = {
    reserveHandle: internal.reserveHandle,
    holdHandle: internal.holdHandle,
    transitionAccountHandle: commands.transitionAccountHandle,
    finalizeHandleTransition: internal.finalizeHandleTransition,
    redirectTransitionHandle: internal.redirectTransitionHandle,
    completeHandleTransition: internal.completeHandleTransition,
    releaseMembershipCoordination: internal.releaseMembershipCoordination,
    setMembership: commands.setMembership,
    tombstone: commands.tombstone,
  };
  for (const phase of Object.keys(native) as (keyof typeof native)[]) {
    Object.assign(ports, { [phase]: intercept(phase, native[phase]) });
  }
  const options = {
    database,
    systemDatabaseUrl: config.systemUrl,
    stagingKey: Buffer.from(config.stagingKey, 'hex'),
    auth: {
      ...auth,
      internal: {
        ...auth.internal,
        async revokeSessions(...args: Parameters<typeof auth.internal.revokeSessions>) {
          const [accountId] = args;
          await beforeRevoke?.(accountId);
          await auth.internal.revokeSessions(...args);
        },
        async provisionPassword(input: Parameters<typeof auth.internal.provisionPassword>[0]) {
          const result = await auth.internal.provisionPassword(input);
          await afterCredential?.(result.accountId, input.authorization);
          return result;
        },
      },
    },
    access: ports,
    clock,
  };
  let workflows = createAccountWorkflows(options);
  return {
    database,
    kernel,
    internal,
    commands,
    operators,
    auth,
    read,
    effects,
    beforeRevocation(callback?: (accountId: string) => Promise<void>) {
      beforeRevoke = callback;
    },
    authenticate(token: string) {
      return access.authenticate(token, { pool: kernel, deadline: Date.now() + 5000 });
    },
    get workflows() {
      return workflows;
    },
    failAfter(phase: string) {
      fault = phase;
    },
    async restart() {
      await workflows.close();
      workflows = createAccountWorkflows(options);
      await workflows.start();
    },
    approve(reference: string, token: string, operation?: AccountOperation) {
      approvals.set(reference, { token, ...(operation ? { operation } : {}) });
    },
    async close() {
      await workflows.close();
      await database.end();
      await kernel.end();
    },
  };
}

// This process deliberately has no in-memory retry/controller. A parent test
// kills it while the official DBOS workflow is durably waiting for activation.
if (import.meta.main) {
  const fixture = await handleFixture(
    JSON.parse(process.env.HANDLE_WORKFLOW_FIXTURE!),
    undefined,
    process.env.HANDLE_WORKFLOW_COMMIT_LOSS
      ? async (accountId, registrationId) => {
          process.stdout.write(JSON.stringify({ accountId, registrationId, workflowId: DBOS.workflowID }) + '\n');
          await new Promise(() => {});
        }
      : undefined,
  );
  await fixture.workflows.start();
  const ref = await fixture.workflows.beginRegistration({
    key: process.env.HANDLE_WORKFLOW_KEY ?? 'process-loss',
    handle: process.env.HANDLE_WORKFLOW_KEY ?? 'process_loss',
  });
  await fixture.workflows.installRegistrationCredential({
    registrationId: ref.registrationId,
    email: process.env.HANDLE_WORKFLOW_EMAIL!,
    password: process.env.HANDLE_WORKFLOW_PASSWORD!,
  });
  process.stdout.write(JSON.stringify(ref) + '\n');
  await new Promise(() => {});
}
