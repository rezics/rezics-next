import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  createAuthHost,
  WEBSITE_CLIENT_ID,
  type PublicJwks,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
  type CredentialEffect,
  type SessionProof,
} from '@rezics/auth';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool, type PoolClient } from 'pg';
import type {
  Approval,
  Binding,
  NativeCredentialEffectDriver,
  Operation,
  Reply,
  Result,
} from '../../../../specs/native-credential-effect-driver.ts';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createPool } from '../../src/database/pool.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createWorkflowApprovals, WORKFLOW_APPROVAL_ACTIONS } from '../../src/access/workflow-approvals.ts';
import { APPROVAL_REFERENCE_PURPOSE } from '../../src/access/approved-identity.ts';
import { AuthBindingDeniedError } from '../../src/access/auth-bindings.ts';
import { OperatorDeniedError } from '../../src/access/operator.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { unseal } from '../../src/tokens/seal.ts';
import { registerTestClient, testKernel, testRouteKey, type TestKernel } from '../support/test-kernel.ts';

const originalPassword = 'native credential original password';
const scopes = [
  'account:manage',
  'account:read',
  'account:update',
  'account:delete',
  'account:suspend',
  'organization:membership',
  'access:grant',
  ...WORKFLOW_APPROVAL_ACTIONS.keys(),
].sort();
type Caller = { headers: Headers; email: string; password: string; clientId: string; scopes: string[] };
const cookies = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });
const iso = (value: string | Date) => new Date(value).toISOString();
const required = <T>(value: T | undefined | null, description: string): T => {
  if (value == null) throw new Error(description);
  return value;
};
async function reply<T>(response: Response): Promise<Reply<T>> {
  // A host's unavailable/failed transport is never an authorization outcome.
  if (response.status >= 500)
    throw new Error(`Auth infrastructure response ${response.status}: ${await response.clone().text()}`);
  return response.status === 200 ? { response, value: (await response.clone().json()) as T } : { response };
}
async function successful<T>(response: Response, command: string): Promise<T> {
  if (!response.ok) throw new Error(`${command}: HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

/** Only credentials and caller handles live in this harness. Approval provenance,
 * policy, narrowing, consumption, floor advancement and effects belong to product.
 */
export async function createNativeCredentialEffectDriver(): Promise<
  NativeCredentialEffectDriver & { advanceClock(milliseconds: number): void }
> {
  let clockOffset = 0;
  const clock = () => new Date(Date.now() + clockOffset);
  const advanceClock = (milliseconds: number) => {
    clockOffset += milliseconds;
  };
  const source = new URL(
    required(process.env.DATABASE_URL, 'DATABASE_URL must name a migrated isolated kernel database'),
  );
  const template = source.pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+$/.test(template)) throw new Error('Unsafe template database name');
  const suffix = randomUUID().replaceAll('-', '');
  const kernelName = `credential_kernel_${suffix}`;
  const authName = `credential_auth_${suffix}`;
  const connection = (name: string) => {
    const url = new URL(source);
    url.pathname = `/${name}`;
    return url.href;
  };
  const admin = new Pool({ connectionString: connection('postgres') });
  const owned: string[] = [];
  let pool: Pool | undefined;
  let authPool: Pool | undefined;
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  let service: AuthService;
  let access: TestKernel['testAccess'];
  let kernelHttp: TestKernel;
  let bindings: ReturnType<typeof createNativeAccountBindings>;
  let approvals: ReturnType<typeof createWorkflowApprovals>;
  const issuer = `https://credential-${suffix}.auth.test`;
  const audience = 'https://credential.api.test';
  let clientId = 'credential-consented';
  const loginClient = 'credential-login';
  const callers = new Map<string, Caller>();
  const organizationFixtures = new Map<string, { owner: string; memberReservationId: string }>();
  const routeKey = testRouteKey();
  const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const stagingKey = randomBytes(32);
  const secret = randomBytes(48).toString('base64url');
  const pair = await generateKeyPair('ES256', { extractable: true });
  const websitePair = await generateKeyPair('ES256', { extractable: true });
  const redirectUri = `${issuer}/website/callback`;
  const signingKey = { ...(await exportJWK(pair.privateKey)), kid: 'native-credential-host' };
  const actions = new Map([...LIFECYCLE_ACTIONS, ...scopes.map((scope) => [scope, { anonymous: false }] as const)]);
  const kernel = () => required(pool, 'Kernel database is closed');
  const auth = () => required(authPool, 'Auth database is closed');
  const currentHost = () => required(host, 'Auth host is stopped');
  const pending = new Set<Promise<Response>>();
  const hostRequest = (input: Request) => {
    const response = currentHost().handler(input);
    pending.add(response);
    void response.then(
      () => pending.delete(response),
      () => pending.delete(response),
    );
    return response;
  };
  const stopHost = async () => {
    // Promise.all can reject before another concurrent Better Auth request settles.
    // Its database must remain open until all issued HTTP requests have completed.
    while (pending.size) await Promise.allSettled([...pending]);
    await host?.stop();
    host = undefined;
  };
  const request = (path: string, body: unknown, caller?: string | Headers) =>
    hostRequest(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: {
          origin: issuer,
          'content-type': 'application/json',
          cookie: (typeof caller === 'string' ? callers.get(caller)?.headers : caller)?.get('cookie') ?? '',
        },
        body: JSON.stringify(body),
      }),
    );
  const remember = (value: Caller) => {
    const handle = randomUUID();
    callers.set(handle, value);
    return handle;
  };
  const login = async (
    email: string,
    password = originalPassword,
    selectedClient = clientId,
    selectedScopes = scopes,
  ) => {
    const response = await request('/signin', { email, password, client_id: selectedClient, scope: selectedScopes });
    await successful(response.clone(), 'native sign-in');
    return remember({ email, password, clientId: selectedClient, scopes: selectedScopes, headers: cookies(response) });
  };
  const context = async (caller: string) => {
    const issued = await successful<{ access_token: string }>(
      await request('/token', {}, caller),
      'native token issuance',
    );
    const boundary = { pool: kernel(), deadline: Date.now() + 10000 };
    const actor = await access.authenticate(issued.access_token, boundary);
    return { ...boundary, actor, account: await readAccount(kernel(), routeOf(actor.accountId)!, actor.accountId) };
  };
  const bearer = async (caller: string) =>
    (await successful<{ access_token: string }>(await request('/token', {}, caller), 'approval bearer')).access_token;
  const build = async () => {
    authPool = new Pool({ connectionString: connection(authName) });
    kernelHttp = testKernel({
      pool: kernel(),
      clock,
      actions,
      tokens: referenceKeys,
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
      },
      writeRate: createWriteRateLimiter({ secret }),
    });
    access = kernelHttp.testAccess;
    const proofs = createNativeWorkflowProofPorts({ database: auth() });
    bindings = createNativeAccountBindings({
      pool: kernel(),
      clock,
      access,
      actions,
      routeKey,
      referenceKeys,
      auth: () => service,
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: auth() }),
        barriers: createBarrierProofVerifier({ database: auth() }),
      },
    });
    approvals = createWorkflowApprovals({
      pool: kernel(),
      access,
      actions,
      referenceKeys,
      creationBinding: (input: { registrationId: string; operationKey: string }) => proofs.creationBinding(input),
    });
    host = await createAuthHost({
      database: auth(),
      systemDatabasePool: auth(),
      issuer,
      audience,
      secret,
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      siteActions: new Map([...actions, ['media:complete', { anonymous: false }]]),
      trustedAccess: bindings.trustedAccess,
      access: bindings.workflowPorts,
      stagingKey,
      maintenanceSchedule: '0 0 1 1 *',
      executorId: `credential-${suffix}`,
    });
    service = host.service;
    await host.start();
    await registerTestClient(service, { clientId: loginClient, firstParty: true, actions, scopes });
    for (const id of [clientId, 'credential-other-client'])
      await registerTestClient(service, { clientId: id, firstParty: false, actions, scopes });
    await service.internal.registerWebsiteClient({
      publicJwks: {
        keys: [{ ...(await exportJWK(websitePair.publicKey)), kid: 'fixture-website', alg: 'ES256', use: 'sig' }],
      } as PublicJwks,
      redirectUris: [redirectUri],
      postLogoutRedirectUris: [`${issuer}/`],
      scopes: ['openid', 'offline_access', 'account:read', 'media:complete'],
    });
  };
  const close = async () => {
    try {
      await stopHost();
    } finally {
      host = undefined;
      await authPool?.end().catch(() => {});
      await pool?.end();
      for (const name of owned.reverse()) {
        const deadline = Date.now() + 5000;
        for (;;) {
          try {
            await admin.query(`DROP DATABASE "${name}"`);
            break;
          } catch (error) {
            // Pool.end can resolve before its sockets finish disconnecting.
            if (!(error instanceof Error) || !('code' in error) || error.code !== '55006' || Date.now() >= deadline)
              throw error;
            await Bun.sleep(25);
          }
        }
      }
      owned.length = 0;
      await admin.end();
    }
  };
  try {
    await admin.query(`CREATE DATABASE "${kernelName}" TEMPLATE "${template}"`);
    owned.push(kernelName);
    await admin.query(`CREATE DATABASE "${authName}"`);
    owned.push(authName);
    migrateAuth(connection(authName), fileURLToPath(new URL('../../../auth/db/migrations', import.meta.url)));
    pool = createPool(connection(kernelName));
    await build();
  } catch (error) {
    await close();
    throw error;
  }

  const refreshToken = async (caller: string) => {
    const verifier = randomBytes(48).toString('base64url');
    const url = new URL(`${issuer}/authorize`);
    url.search = new URLSearchParams({
      client_id: WEBSITE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid offline_access account:read',
      state: randomUUID(),
      nonce: randomUUID(),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: audience,
    }).toString();
    const authorization = await hostRequest(
      new Request(url, { headers: required(callers.get(caller), 'Missing website login').headers }),
    );
    if (authorization.status !== 302)
      throw new Error(`Native website authorization: ${authorization.status}: ${await authorization.text()}`);
    const code = required(
      new URL(required(authorization.headers.get('location'), 'Missing authorization redirect')).searchParams.get(
        'code',
      ),
      'Missing native authorization code',
    );
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'fixture-website' })
      .setIssuer(WEBSITE_CLIENT_ID)
      .setSubject(WEBSITE_CLIENT_ID)
      .setAudience(issuer)
      .setIssuedAt()
      .setExpirationTime('120s')
      .setJti(randomUUID())
      .sign(websitePair.privateKey);
    const response = await hostRequest(
      new Request(`${issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: WEBSITE_CLIENT_ID,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
          resource: audience,
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      }),
    );
    return (await successful<{ refresh_token: string }>(response, 'native refresh token issuance')).refresh_token;
  };
  const person = async () => {
    const key = randomUUID();
    const email = `${key}@credential.test`;
    const { accountId } = await currentHost().workflows.register({
      key,
      handle: `human_${key.replaceAll('-', '')}`,
      email,
      password: originalPassword,
    });
    const initial = await login(email, originalPassword, loginClient);
    for (const id of [clientId, 'credential-other-client'])
      await successful(await request('/consent', { client_id: id, scope: scopes }, initial), 'native consent');
    const caller = await login(email);
    return { accountId, caller, email };
  };
  const publicKey = async () => {
    const keyPair = await generateKeyPair('ES256', { extractable: true });
    const kid = randomUUID();
    return {
      credential: {
        kind: 'key' as const,
        kid,
        publicJwk: { ...(await exportJWK(keyPair.publicKey)), alg: 'ES256', kid },
      },
      privateKey: JSON.stringify(await exportJWK(keyPair.privateKey)),
    };
  };
  const stage = (caller: string, input: { key: string; subjectId: string; credential: CredentialEffect }) =>
    request('/credential-effects/stage', input, caller).then(reply<Operation>);
  const approve = (caller: string, operation: Operation) =>
    request('/credential-effects/approve', operation, caller).then(reply<Approval>);
  const apply = (caller: string, reference: unknown, operation: Operation) =>
    request('/credential-effects/apply', { ...operation, reference }, caller).then(reply<Result>);
  const install = async (caller: string, subjectId: string, credential: CredentialEffect) => {
    const op = required(
      (await stage(caller, { key: `fixture:${randomUUID()}`, subjectId, credential })).value,
      'Fixture credential stage refused',
    );
    const approval = required((await approve(caller, op)).value, 'Fixture credential approval refused');
    const result = await apply(caller, approval.reference, op);
    required(result.value, `Fixture credential apply refused: ${result.response.status}`);
  };
  let governor: Awaited<ReturnType<typeof person>> | undefined;
  const governance = async () => {
    if (!governor) {
      governor = await person();
      await bootstrapGovernance(kernel(), governor.accountId);
    }
    return governor;
  };
  const nativeBinding = async (reference: string): Promise<Binding> => {
    const locator = required(
      unseal(referenceKeys, 'access.credential-opening.v1', reference),
      'Invalid native credential locator',
    ) as { kind: string; reference: string; operatorAccountId: string; receiptId: string; effectReference: string };
    const effect = required(
      (await auth().query('SELECT * FROM auth_effect_receipt WHERE effect_reference=$1', [locator.effectReference]))
        .rows[0],
      'Missing Auth stage',
    );
    let native;
    if (locator.kind === 'workflow-approval') {
      const inner = required(
        unseal(referenceKeys, APPROVAL_REFERENCE_PURPOSE, locator.reference),
        'Invalid workflow locator',
      ) as { route: number; id: string };
      native = required(
        (
          await kernel().query('SELECT * FROM access.workflow_approval WHERE route=$1 AND approval_id=$2', [
            inner.route,
            inner.id,
          ])
        ).rows[0],
        'Missing workflow approval',
      );
    } else
      native = required(
        (
          await kernel().query(
            'SELECT * FROM access.operator_opening_receipt WHERE route=$1 AND operator_account_id=$2 AND receipt_id=$3',
            [routeOf(locator.operatorAccountId), locator.operatorAccountId, locator.receiptId],
          )
        ).rows[0],
        'Missing operator opening',
      );
    return {
      key: effect.operation_key,
      subjectId: effect.account_id,
      purpose: effect.purpose,
      effectRef: effect.effect_reference,
      digest: effect.effect_digest,
      humanId: native.actor_id ?? native.acting_human_id,
      clientId: native.client_id,
      scopes: native.scopes,
      operatorId: native.operator_account_id ?? null,
      nativePurpose: native.purpose ?? null,
      openingId: native.receipt_id ?? null,
      createdAt: iso(native.created_at),
      expiresAt: iso(native.expires_at),
    };
  };

  return {
    async seed(mode, sessions = 1) {
      // Each independent fixture starts alongside Auth's real-time proof budgets.
      clockOffset = 0;
      const root = await governance();
      clientId = `credential-${randomUUID()}`;
      await registerTestClient(service, { clientId, firstParty: false, actions, scopes });
      const human = await person();
      const other = await person();
      const owner = mode === 'organization-operator' ? await person() : other;
      const organizationId = newId(routeOf(human.accountId)!);
      const reservation = await bindings.internalLifecycle.reserveCoordination({
        accountId: owner.accountId,
        relatedAccountId: organizationId,
        purpose: 'membership',
        key: randomUUID(),
      });
      await bindings.internalLifecycle.createOrganization({
        organizationId,
        ownerAccountId: owner.accountId,
        ownerReservationId: reservation.value.reservationId,
        key: randomUUID(),
      });
      await bindings.operators.provisionManagementDefaults({ operatorAccountId: organizationId, key: randomUUID() });
      if (mode === 'organization-operator') {
        const member = await bindings.internalLifecycle.reserveCoordination({
          accountId: human.accountId,
          relatedAccountId: organizationId,
          purpose: 'membership',
          key: randomUUID(),
        });
        await bindings.lifecycle.setMembership(await context(owner.caller), {
          organizationId,
          memberAccountId: human.accountId,
          reservationId: member.value.reservationId,
          role: 'member',
          key: randomUUID(),
        });
        await bindings.grants.create(await context(owner.caller), {
          resource: { route: routeOf(organizationId)!, id: organizationId },
          subjectId: human.accountId,
          subjectRole: '',
          actions: ['account:manage'],
          valid: '(,)',
          key: randomUUID(),
        });
        organizationFixtures.set(organizationId, {
          owner: owner.caller,
          memberReservationId: member.value.reservationId,
        });
      }
      const operatorId = mode === 'own-human' ? null : mode === 'human-operator' ? human.accountId : organizationId;
      const automated = async (operator: string, manager: string) => {
        const key = randomUUID();
        const handle = `bot_${key.replaceAll('-', '')}`;
        const operation = {
          kind: 'automated' as const,
          registrationId: '',
          operatorAccountId: operator,
          handle,
          operationKey: key,
          authorization: 'approval-request',
        };
        const approval = await approvals.approve(
          await bearer(manager),
          { operationKey: key, operation },
          { pool: kernel(), deadline: Date.now() + 10000 },
        );
        const email = `${key}@credential.test`;
        const created = await currentHost().workflows.createAutomated({
          key,
          handle,
          operatorAccountId: operator,
          authorization: approval.reference,
          credential: { email, password: originalPassword },
        });
        return { ...created, email };
      };
      const botManager = operatorId === null ? other.caller : human.caller;
      const bot = await automated(operatorId ?? other.accountId, botManager);
      const subjectId = operatorId === null ? human.accountId : bot.accountId;
      const existing = await publicKey();
      const otherExisting = await publicKey();
      const candidate = await publicKey();
      await install(human.caller, subjectId, existing.credential);
      await install(human.caller, subjectId, otherExisting.credential);
      const otherClient = await login(human.email, originalPassword, 'credential-other-client');
      if (subjectId !== bot.accountId) await install(botManager, bot.accountId, (await publicKey()).credential);
      // Retain fixture credentials only in the harness; sign-in still runs through Auth.
      const automatedCaller = await login(bot.email, originalPassword, loginClient);
      const caller = required(callers.get(human.caller), 'Missing caller');
      // Count the source proof's session in the requested subject cardinality.
      for (let n = subjectId === human.accountId ? 3 : 1; n < sessions; n++)
        await login(
          subjectId === human.accountId ? human.email : bot.email,
          originalPassword,
          subjectId === human.accountId ? clientId : loginClient,
        );
      const token = await successful<{ access_token: string }>(
        await request('/token', {}, human.caller),
        'fixture tokens',
      );
      const floor = (
        await kernel().query('SELECT minimum_authn_epoch::text AS floor FROM access.account WHERE account_id=$1', [
          subjectId,
        ])
      ).rows[0].floor as string;
      void root;
      return {
        mode,
        humanId: human.accountId,
        subjectId,
        otherSubjectId: other.accountId,
        organizationId,
        operatorId,
        caller: human.caller,
        otherHuman: other.caller,
        otherClient,
        automatedCaller,
        unauthenticated: randomUUID(),
        clientId: caller.clientId,
        scopes: caller.scopes,
        floor,
        password: `candidate password ${randomUUID()}`,
        otherPassword: `different password ${randomUUID()}`,
        existingKid: existing.credential.kid,
        otherExistingKid: otherExisting.credential.kid,
        newKey: candidate.credential,
        privateKey: candidate.privateKey,
        rawAccessToken: token.access_token,
        rawRefreshToken: await refreshToken(human.caller),
      };
    },
    stage,
    approve,
    async apply(caller, reference, operation, checkpoint) {
      if (!checkpoint) return apply(caller, reference, operation);
      const hook = checkpoint.at === 'before-native-consume' ? 'before-consume' : 'consumed';
      return atBoundary(hook, checkpoint.run, () => apply(caller, reference, operation));
    },
    async broadOpening(f, purpose) {
      const opened = await bindings.operators.authorizeOpening(await context(f.caller), {
        operatorAccountId: required(f.operatorId, 'Broad opening requires operator'),
        subjectAccountId: f.subjectId,
        purpose,
        key: randomUUID(),
      });
      return opened.value.receiptId;
    },
    async otherPurpose(caller, reference, subjectId, purpose) {
      if (purpose === 'device')
        return reply(await request('/device', { authorization: reference, account_id: subjectId }, caller));
      try {
        const response = await service.internal.openAutomatedSession({
          authorization: reference,
          subjectAccountId: subjectId,
          headers: required(callers.get(caller), 'Missing caller').headers,
        });
        return reply(response);
      } catch (error) {
        if (error instanceof AuthBindingDeniedError || error instanceof OperatorDeniedError)
          return { response: Response.json({ error: error.name }, { status: 401 }) };
        if (
          error instanceof Error &&
          error.constructor.name === 'Denied' &&
          error.message === 'Authentication denied' &&
          'status' in error &&
          typeof error.status === 'number' &&
          [400, 401, 403, 409].includes(error.status)
        )
          return { response: Response.json({ error: 'authentication_denied' }, { status: error.status }) };
        throw error;
      }
    },
    binding: nativeBinding,
    async inspect(f) {
      const targets = [
        ...new Set([
          f.humanId,
          f.subjectId,
          f.otherSubjectId,
          f.organizationId,
          ...(f.operatorId ? [f.operatorId] : []),
        ]),
      ].sort();
      const credentials = (
        await auth().query('SELECT * FROM account WHERE "userId"=ANY($1::text[]) ORDER BY id', [targets])
      ).rows;
      const keys = (
        await auth().query(
          'SELECT *,xmin::text AS row_version FROM auth_public_key WHERE account_id=ANY($1::text[]) ORDER BY account_id,kid',
          [targets],
        )
      ).rows;
      const effects = (
        await auth().query(
          "SELECT * FROM auth_effect_receipt WHERE account_id=ANY($1::text[]) AND committed_at IS NOT NULL AND operation_key NOT LIKE 'fixture:%' ORDER BY receipt_id",
          [targets],
        )
      ).rows;
      const floors = (
        await kernel().query(
          'SELECT account_id,minimum_authn_epoch::text,authn_fenced AS fenced FROM access.account WHERE account_id=ANY($1::uuid[]) ORDER BY account_id',
          [targets],
        )
      ).rows;
      const openings = (
        await kernel().query(
          'SELECT receipt_id,consumed_at,consumed_transaction_id FROM access.operator_opening_receipt WHERE subject_account_id=ANY($1::uuid[]) ORDER BY receipt_id',
          [targets],
        )
      ).rows;
      const own = (
        await kernel().query(
          "SELECT approval_id,consumed_at,consumed_transaction_id FROM access.workflow_approval WHERE actor_id=ANY($1::uuid[]) AND operation->>'kind'='credential' ORDER BY approval_id",
          [targets],
        )
      ).rows;
      const sessionRows = (
        await auth().query('SELECT id,"userId" FROM session WHERE "userId"=ANY($1::text[]) ORDER BY id', [targets])
      ).rows;
      const hash = credentials.find((row) => row.userId === f.subjectId && row.providerId === 'credential')
        ?.password as string | null | undefined;
      const { verifyPassword } = createRequire(new URL('../../../auth/package.json', import.meta.url))(
        'better-auth/crypto',
      ) as { verifyPassword(input: { hash: string; password: string }): Promise<boolean> };
      return {
        state: { credentials, keys, effects, floors, openings, own, sessions: sessionRows },
        floor: required(
          floors.find((row) => row.account_id === f.subjectId),
          'Missing subject floor',
        ).minimum_authn_epoch,
        sessions: sessionRows.filter((row) => row.userId === f.subjectId).map((row) => row.id),
        committed: effects.map((row) => ({
          key: row.operation_key,
          subjectId: row.account_id,
          purpose: row.purpose,
          effectRef: row.effect_reference,
          digest: row.effect_digest,
          receiptId: row.receipt_id,
        })),
        passwordInstalled: !!hash,
        candidatePasswordMatches: !!hash && (await verifyPassword({ hash, password: f.password })),
        keyIds: keys
          .filter((row) => row.account_id === f.subjectId)
          .map((row) => row.kid)
          .sort(),
      };
    },
    async automateOperator(f) {
      const operatorId = required(f.operatorId, 'Missing operator');
      const next = await context(f.otherHuman);
      const current = required(
        await readAccount(kernel(), routeOf(operatorId)!, operatorId),
        'Missing operator account',
      );
      try {
        const reservation = await bindings.operators.reserveResponsibility({
          operatorAccountId: next.actor.accountId,
          subjectAccountId: operatorId,
          key: randomUUID(),
        });
        const result = await bindings.operators.recordOperatorRelation({
          ...reservation.value,
          expectedOperatorAccountId: current.operatorAccountId,
          expectedVersion: '0',
          key: randomUUID(),
        });
        return { response: Response.json(result.value), value: result.value };
      } catch (error) {
        if (!(error instanceof OperatorDeniedError)) throw error;
        return {
          response: Response.json({ error: error.name, effect_status: 'not_applied' }, { status: 409 }),
        };
      }
    },
    async revoke(f, fact) {
      const gov = await governance();
      if (fact === 'actor-grant') {
        const organization = required(organizationFixtures.get(f.organizationId), 'Missing organization owner');
        await bindings.grants.revoke(await context(organization.owner), {
          resource: { route: routeOf(f.organizationId)!, id: f.organizationId },
          subjectId: f.humanId,
          subjectRole: '',
          actions: ['account:manage'],
          valid: '(,)',
          key: randomUUID(),
        });
      } else if (fact === 'consent') {
        const human = required(callers.get(f.caller), 'Missing consenting human');
        const current = await login(human.email, human.password, loginClient);
        await successful(
          await request(
            '/consent',
            { client_id: f.clientId, scope: scopes.filter((scope) => scope !== 'account:manage') },
            current,
          ),
          'native consent revocation',
        );
      } else if (fact === 'scope') {
        const key = randomUUID();
        const operation = {
          kind: 'client-reduction' as const,
          clientId: f.clientId,
          firstParty: false,
          scopes: scopes.filter((scope) => scope !== 'account:manage'),
          authorization: 'approval-request',
        };
        const approval = await approvals.approve(
          await bearer(gov.caller),
          { operationKey: key, operation },
          { pool: kernel(), deadline: Date.now() + 10000 },
        );
        await currentHost().workflows.reduceClientScopes({ ...operation, authorization: approval.reference, key });
      } else if (fact === 'missing-evidence') {
        const resourceId = f.operatorId ?? f.subjectId;
        const owner = organizationFixtures.get(f.organizationId)?.owner;
        await successful(
          await kernelHttp.handle(
            new Request(`${audience}/v1/grants:revoke`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${await bearer(owner ?? f.caller)}`,
                'content-type': 'application/json',
                'idempotency-key': JSON.stringify(randomUUID()),
              },
              body: JSON.stringify({
                resource: { route: routeOf(resourceId)!, id: resourceId },
                subject: { kind: 'account', id: f.humanId },
                actions: ['account:manage'],
                valid: '(,)',
              }),
            }),
          ),
          'native grant renunciation',
        );
      } else if (fact === 'human-floor' || fact === 'subject-floor' || fact === 'operator-floor') {
        if (fact === 'operator-floor' && f.operatorId === f.organizationId) {
          // Organizations have no Auth credentials; suspension advances their native floor.
          await createSuspensionCommands({ pool: kernel(), access, clock }).suspend(await context(gov.caller), {
            accountId: f.organizationId,
            key: randomUUID(),
          });
          return;
        }
        const subjectId =
          fact === 'human-floor'
            ? f.humanId
            : fact === 'subject-floor'
              ? f.subjectId
              : required(f.operatorId, 'Missing operator');
        const human = required(callers.get(f.caller), 'Missing managing human');
        const current = await login(human.email, human.password, human.clientId, human.scopes);
        const password = `barrier password ${randomUUID()}`;
        await install(current, subjectId, { kind: 'password', password });
        const subject = required(
          callers.get(subjectId === f.humanId ? f.caller : f.automatedCaller),
          'Missing subject credentials',
        );
        for (const caller of callers.values()) if (caller.email === subject.email) caller.password = password;
      } else if (fact === 'human-suspended') {
        await createSuspensionCommands({ pool: kernel(), access, clock }).suspend(await context(gov.caller), {
          accountId: f.humanId,
          key: randomUUID(),
        });
      } else if (fact === 'organization-membership') {
        const organization = required(organizationFixtures.get(f.organizationId), 'Missing organization owner');
        await bindings.lifecycle.setMembership(await context(organization.owner), {
          organizationId: f.organizationId,
          memberAccountId: f.humanId,
          reservationId: organization.memberReservationId,
          role: null,
          key: randomUUID(),
        });
      } else if (fact === 'operator-relation') {
        const opening = await bindings.operators.authorizeOpening(await context(f.caller), {
          operatorAccountId: required(f.operatorId, 'Missing operator'),
          subjectAccountId: f.subjectId,
          purpose: 'credential-management',
          key: randomUUID(),
        });
        const reservation = await bindings.operators.reserveResponsibility({
          operatorAccountId: f.otherSubjectId,
          subjectAccountId: f.subjectId,
          key: randomUUID(),
        });
        await bindings.operators.recordOperatorRelation({
          ...reservation.value,
          expectedOperatorAccountId: f.operatorId,
          expectedVersion: opening.value.version,
          key: randomUUID(),
        });
      } else if (fact === 'subject-fenced') {
        await bindings.internalLifecycle.raiseFence({ accountId: f.subjectId, key: randomUUID() });
      } else if (fact === 'subject-deleted')
        await bindings.lifecycle.tombstone(await context(f.subjectId === f.humanId ? f.caller : f.automatedCaller), {
          accountId: f.subjectId,
          key: randomUUID(),
        });
    },
    async signInAutomated(f, credential) {
      const { email } = required(callers.get(f.automatedCaller), 'Missing automated fixture caller');
      const response = await request('/signin', {
        email,
        ...(credential !== 'none'
          ? { password: credential === 'own' ? originalPassword : 'incorrect native credential password' }
          : {}),
        client_id: loginClient,
        scope: scopes,
      });
      if (response.status !== 200) return reply(response);
      return reply<SessionProof>(response);
    },
    async authenticateAgain(f) {
      const caller = required(callers.get(f.caller), 'Missing human login');
      return login(caller.email, caller.password, caller.clientId, caller.scopes);
    },
    advanceClock,
    async awaitExpiry(reference) {
      const binding = await nativeBinding(reference);
      advanceClock(Math.max(0, Date.parse(binding.expiresAt) + 1 - clock().getTime()));
    },
    async loseAcknowledgement(f, approval, operation, at) {
      const lost = new Error(`Dropped native ${at} acknowledgement`);
      let reached = false;
      try {
        await atBoundary(
          at === 'opening-consumed' ? 'consumed' : 'committed',
          async () => {
            reached = true;
            throw lost;
          },
          () => apply(f.caller, approval.reference, operation),
        );
      } catch (error) {
        if (!reached) throw error;
      }
      if (!reached) throw new Error(`Native ${at} checkpoint was not reached`);
      await stopHost();
      host = undefined;
      authPool = undefined;
    },
    async restart() {
      await stopHost();
      host = undefined;
      authPool = undefined;
      await build();
    },
    async persisted(f) {
      const rows = async (database: Pool, schema: string) => {
        const tables = (
          await database.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [schema])
        ).rows;
        const result: unknown[] = [];
        for (const table of tables)
          result.push(
            ...(
              await database.query(
                `SELECT to_jsonb(t) AS data FROM "${schema}"."${String(table.tablename).replaceAll('"', '""')}" t`,
              )
            ).rows.map((row) => row.data),
          );
        return result;
      };
      const accessRows = await rows(kernel(), 'access');
      const durableRows = await rows(auth(), 'auth_dbos');
      const encoded = JSON.stringify([...accessRows, ...durableRows]);
      const count = (value: string) => (value ? encoded.split(JSON.stringify(value).slice(1, -1)).length - 1 : 0);
      const records: Record<string, unknown>[] = [];
      const visit = (value: unknown) => {
        if (typeof value === 'string') {
          try {
            const parsed: unknown = JSON.parse(value);
            if (parsed && typeof parsed === 'object') visit(parsed);
          } catch {
            // Ordinary persisted strings are leaves, not serialized workflow data.
          }
        } else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') {
          records.push(value as Record<string, unknown>);
          Object.values(value).forEach(visit);
        }
      };
      visit([...accessRows, ...durableRows]);
      const hashes = (await auth().query('SELECT password FROM account WHERE password IS NOT NULL')).rows;
      return {
        accessRows: accessRows.length,
        durableRows: durableRows.length,
        nonsecretReferences: (encoded.match(/effectReference|effect_reference|registrationId|registration_id/g) ?? [])
          .length,
        plaintextPasswords: count(f.password) + count(f.otherPassword) + count(originalPassword),
        privateKeys: count(f.privateKey) + count((JSON.parse(f.privateKey) as { d: string }).d),
        tokens:
          count(f.rawAccessToken) +
          count(f.rawRefreshToken) +
          [...callers.values()].reduce((sum, caller) => sum + count(caller.headers.get('cookie') ?? ''), 0),
        permissionContexts: records.filter((record) => {
          const actor = record.actor as Record<string, unknown> | undefined;
          return 'permissionContext' in record || 'permission_context' in record || actor?.kind === 'account';
        }).length,
        credentialPayloads:
          hashes.reduce((sum, row) => sum + count(row.password), 0) +
          records.filter((record) => record.kty === 'EC' && record.crv === 'P-256' && record.x && record.y).length,
      };
    },
    close,
  };

  /** Pause actual SQL transport boundaries. Never replace a native authorization
   * port or run a private formula; native command locks are released before callbacks.
   */
  async function atBoundary<T>(
    at: 'before-consume' | 'consumed' | 'committed',
    run: () => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const runOutsideCommand = AsyncResource.bind(run);
    const databases = at === 'consumed' ? [kernel(), auth()] : [auth()];
    const originals = new Map<PoolClient, PoolClient['query']>();
    let fired = false;
    let nativeCommitted = false;
    const intercept = (database: Pool) => (client: PoolClient) => {
      if (originals.has(client)) return;
      const query = client.query.bind(client);
      originals.set(client, client.query);
      let consumed = false;
      let committed = false;
      client.query = ((...args: Parameters<typeof query>) => {
        const raw = args[0] as string | { text: string };
        const sql = typeof raw === 'string' ? raw : raw.text;
        if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') {
          consumed = false;
          committed = false;
        }
        if (/UPDATE access\.(workflow_approval|operator_opening_receipt)[\s\S]*SET consumed_at/.test(sql))
          consumed = true;
        if (sql.includes('UPDATE auth_effect_receipt SET opening_receipt_id')) committed = true;
        const invoke = query as (...values: unknown[]) => unknown;
        const last = args.at(-1);
        // Let the native command release its client and partition gate. Pause
        // Auth's credential owner-lock read before it acquires any lock. A
        // background DBOS query must never take the request's checkpoint.
        if (at === 'consumed' && database === kernel() && sql === 'COMMIT' && consumed) {
          if (typeof last === 'function') {
            const callback = last as (error: unknown, value?: unknown) => void;
            return invoke(...args.slice(0, -1), (error: unknown, value: unknown) => {
              if (!error) nativeCommitted = true;
              callback(error, value);
            });
          }
          return (invoke(...args) as Promise<unknown>).then((value) => {
            nativeCommitted = true;
            return value;
          });
        }
        const match =
          at === 'before-consume'
            ? /SELECT (?:id,password,)?xmin::text AS version FROM (?:account|auth_public_key)/.test(sql)
            : at === 'consumed'
              ? database === auth() && nativeCommitted && sql === 'SELECT auth_assert_session_capacity($1,true)'
              : sql === 'COMMIT' && committed;
        if (fired || !match) return invoke(...args);
        fired = true;
        if (at === 'consumed') {
          if (typeof last === 'function') {
            const callback = last as (error: unknown, value?: unknown) => void;
            void runOutsideCommand().then(() => invoke(...args), callback);
            return;
          }
          return runOutsideCommand().then(() => invoke(...args));
        }
        if (typeof last === 'function') {
          const callback = last as (error: unknown, value?: unknown) => void;
          return invoke(...args.slice(0, -1), (error: unknown, value: unknown) => {
            if (error) return callback(error);
            void runOutsideCommand().then(() => callback(null, value), callback);
          });
        }
        return (invoke(...args) as Promise<unknown>).then(async (value) => {
          await runOutsideCommand();
          return value;
        });
      }) as typeof client.query;
    };
    const listeners = databases.map((database) => ({ database, listener: intercept(database) }));
    for (const { database, listener } of listeners) database.on('acquire', listener);
    try {
      return await operation();
    } finally {
      for (const { database, listener } of listeners) database.off('acquire', listener);
      for (const [client, query] of originals) client.query = query;
    }
  }
}
