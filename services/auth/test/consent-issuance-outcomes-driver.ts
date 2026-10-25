import { setImmediate } from 'node:timers/promises';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, createBarrierProofVerifier, createProvisioningEvidenceVerifier } from '../src/index.ts';
import { createAuthBindings } from '../../kernel/src/access/auth-bindings.ts';
import { createAuthBarrierCapabilities } from '../../kernel/src/access/auth-barriers.ts';
import { createLifecycleInternals } from '../../kernel/src/access/lifecycle.ts';
import { createAccess } from '../../kernel/src/access/index.ts';
import { accessCheck, AuthenticationError } from '../../kernel/src/request/access.ts';
import { newId } from '../../kernel/src/route/route.ts';
import { migrate } from '../../kernel/scripts/database.ts';

export const retained = 'subject:read';
export const removed = 'subject:update';
export type Identity = 'target' | 'other-account' | 'other-client';
export type Attempt = { signin: Response; token: Response | null; jwt: string | null };
export type PendingAttempt = { result: Promise<Attempt> };
export type Evidence = {
  proof: { reference: string; operationKey: string; digest: string; previousEpoch: number; receiptId: string | null };
  receipt: { receiptId: string; accountId: string; minimumAuthnEpoch: string };
  account: { accountId: string; minimumAuthnEpoch: string; fenced: boolean };
  consent: { revision: string; scopes: string[] };
  events: string[];
};

/** Transport and durable observations only. Outcome policy belongs to the suite.
 * A native implementation must forward the real callback, never mint a receipt,
 * alter a JWT, or replace Access authentication/authorization with a scope check.
 */
export interface ConsentIssuanceDriver {
  startReduction(): Promise<Evidence>;
  beginAttempt(identity: Identity, scopes: string[]): PendingAttempt;
  atGap(attempt: PendingAttempt): Promise<'completed' | 'blocked'>;
  finish(mode: 'resume' | 'restart'): Promise<Response>;
  inspect(): Promise<Evidence>;
  use(jwt: string, scope: string): Promise<{ authenticated: boolean; allowed: boolean; epoch: number | null }>;
  close(): Promise<void>;
}

function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function cookie(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}
function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

/** Test-only composition of the installed native factories, not the unavailable
 * general account-workflow binding. Setup activates from committed Auth evidence
 * and real pending/claim/activate commands; no provisioning Map proves lifecycle.
 */
export async function createNativeDriver(max = 4): Promise<ConsentIssuanceDriver> {
  const fixture = testDatabase();
  const database = new Pool({ connectionString: fixture.url, max, connectionTimeoutMillis: 2000,
    application_name: 'consent-outcome-auth' });
  const observer = new Pool({ connectionString: fixture.url, max: 1 });
  const kernelUrl = new URL(fixture.url);
  kernelUrl.pathname = '/consent_kernel';
  let kernel: Pool | undefined;
  try {
    await observer.query('CREATE DATABASE consent_kernel');
    migrate(kernelUrl.href);
    kernel = new Pool({ connectionString: kernelUrl.href, max: 4 });
    return await nativeDriver(database, observer, kernel, async () => {
      await Promise.all([database.end(), observer.end(), kernel!.end()]);
      fixture.close();
    });
  } catch (error) {
    await Promise.all([database.end(), observer.end(), kernel?.end()]);
    fixture.close();
    throw error;
  }
}

async function nativeDriver(database: Pool, observer: Pool, kernel: Pool, cleanup: () => Promise<void>) {
  const issuer = 'https://consent-outcomes.auth.test';
  const audience = 'https://consent-outcomes.api.test';
  const password = 'native personal consent password';
  const scopes = [retained, removed];
  const ids = [newId(915), newId(915)];
  const target = ids[0]!;
  const resource = { route: 915, id: newId(915) };
  const provisioning = createProvisioningEvidenceVerifier({ database: observer });
  const lifecycle = createLifecycleInternals({ pool: kernel, routeKey: new Uint8Array(32).fill(61),
    provisioningEvidence: (reference) => provisioning.resolve(reference), recoveryEvidence: async () => null });
  const proofs = createBarrierProofVerifier({ database: observer });
  const barriers = createAuthBarrierCapabilities({ lifecycle, proofs });
  const ports = { ...createAuthBindings({ pool: kernel }), ...barriers.trustedAccess };
  const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'native' };
  const options = { database, issuer, audience, secret: 'native-consent-outcome-secret-with-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] }, trustedAccess: ports };
  const events: string[] = [];
  const paused = signal<Evidence>();
  const release = signal<'resume' | 'restart'>();
  let input: Parameters<NonNullable<typeof ports.invalidateAccount>>[0];
  let pause = true;
  let reduction: Promise<Response> | undefined;
  let controller = '';
  const inspect = async (): Promise<Evidence> => {
    const proof = requireValue((await observer.query(
      `SELECT reference,operation_key AS "operationKey",digest,previous_epoch AS "previousEpoch",
        applied_receipt_id AS "receiptId" FROM auth_barrier_proof WHERE reference=$1`, [input.proofReference],
    )).rows[0], 'Missing committed Auth proof');
    const state = requireValue(await lifecycle.readFenceState(target), 'Missing native floor');
    const receipt = requireValue(await lifecycle.readFenceReceipt(target, state.receiptId!), 'Missing native receipt');
    const consent = requireValue((await observer.query(
      'SELECT revision::text,scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2', [target, 'external'],
    )).rows[0], 'Missing exact consent');
    return { proof, receipt, account: { accountId: target, minimumAuthnEpoch: state.minimumAuthnEpoch,
      fenced: state.fenced }, consent, events: [...events] };
  };
  const trustedAccess = { ...ports, async invalidateAccount(actual: typeof input) {
    input = actual;
    const proof = await proofs.verify(actual.proofReference!, { accountId: actual.accountId,
      purpose: 'consent-reduction', previousEpoch: actual.previousEpoch, operationKey: actual.operationKey! });
    requireValue(proof, 'Proof must be visible on a separate connection before native Access');
    events.push('committed-auth-proof');
    const receipt = await ports.invalidateAccount(actual);
    events.push('committed-access-receipt');
    if (pause) {
      pause = false;
      events.push('paused-before-consent-cas');
      paused.resolve(await inspect());
      if (await release.promise === 'restart') throw new Error('Lost acknowledgement after native commit');
    }
    return receipt;
  } };
  let service = await createAuthService({ ...options, trustedAccess });
  async function request(path: string, body: unknown, session = '') {
    return service.handler(new Request(`${issuer}${path}`, { method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: session }, body: JSON.stringify(body) }));
  }
  for (const clientId of ['web', 'external', 'unrelated'])
    await service.internal.registerClient({ clientId, firstParty: clientId !== 'external', scopes });
  for (const id of ids) {
    const handle = `consent_${id.replaceAll('-', '')}`;
    const claim = await lifecycle.reserveHandle({ handle, accountId: id, key: `reserve:${id}` });
    const pending = { handle, accountId: id, reservationId: claim.value.reservationId, key: `pending:${id}` };
    await lifecycle.createPending(pending);
    const setupPorts = createAuthBindings({ pool: kernel, async verifyProvisioningReceipt(reference) {
      return reference === pending.key ? (await lifecycle.createPending(pending)).value : null;
    } });
    const setup = await createAuthService({ ...options, trustedAccess: { ...setupPorts,
      async authorizeProvisioning(reference) {
        const approval = await setupPorts.authorizeProvisioning!(reference);
        const receipt = (await lifecycle.createPending(pending)).value;
        const account = requireValue(await setupPorts.readProvisioningAccount!(id, reference), 'Missing pending account');
        return { ...approval, receipt: { ...receipt, reservationId: pending.reservationId, authnEpoch: account.authnEpoch } };
      } } });
    const provision = await setup.internal.provisionPassword({ authorization: pending.key,
      idempotencyKey: `credential:${id}`, email: `${id}@example.test`, password });
    requireValue(await provisioning.resolve(provision.provisioningEvidence), 'Missing native provisioning evidence');
    await lifecycle.claimHandle({ ...pending, key: `claim:${id}` });
    await lifecycle.activate({ accountId: id, key: `activate:${id}`, evidence: provision.provisioningEvidence });
    // Isolated resource grants are setup only; the tested mutation is HTTP /consent.
    for (const action of scopes) await kernel.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES ($1,$2,$3,$4,'(,)',$3)`, [resource.route, resource.id, id, action]);
    const login = await request('/signin', { account_id: id, password, client_id: 'web', scope: scopes });
    if (login.status !== 200) throw new Error(`Native setup sign-in: ${login.status}`);
    const session = cookie(login);
    if (id === target) controller = session;
    const consent = await request('/consent', { client_id: 'external', scope: scopes }, session);
    if (consent.status !== 200) throw new Error(`Native setup consent: ${consent.status}`);
  }
  const access = createAccess({ actions: new Map(scopes.map((scope) => [scope, { anonymous: false }])),
    auth: { issuer, audience, jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: (url, init) => service.handler(new Request(url, init)) } });
  const completed = new WeakSet<PendingAttempt>();
  const driver: ConsentIssuanceDriver = {
    async startReduction() {
      reduction = request('/consent', { client_id: 'external', scope: [retained] }, controller);
      return Promise.race([paused.promise, reduction.then((response) => {
        throw new Error(`Reduction returned ${response.status} before real receipt pause`);
      })]);
    },
    beginAttempt(identity, selected) {
      const attempt: PendingAttempt = { result: (async () => {
        events.push('signin-http-start');
        const signin = await request('/signin', { account_id: identity === 'other-account' ? ids[1] : target,
          password, client_id: identity === 'other-client' ? 'unrelated' : 'external', scope: selected });
        events.push('signin-http-complete');
        if (!signin.ok) return { signin, token: null, jwt: null };
        const token = await request('/token', {}, cookie(signin));
        events.push('token-http-complete');
        const jwt = token.ok ? (await token.clone().json() as { access_token: string }).access_token : null;
        return { signin, token, jwt };
      })() };
      void attempt.result.then(() => completed.add(attempt), () => completed.add(attempt));
      return attempt;
    },
    async atGap(attempt) {
      // Actual PostgreSQL advisory wait, never elapsed-time inference. The only
      // concurrent Auth operations here are the held reduction and this attempt.
      const deadline = Date.now() + 10_000;
      while (!completed.has(attempt)) {
        if (Date.now() > deadline) throw new Error('No completion or native advisory wait observed');
        const waits = await observer.query(`SELECT pid FROM pg_stat_activity
          WHERE application_name='consent-outcome-auth' AND wait_event_type='Lock'
            AND wait_event='advisory' AND cardinality(pg_blocking_pids(pid))>0`);
        if (waits.rowCount) return 'blocked';
        await setImmediate();
      }
      return 'completed';
    },
    async finish(mode) {
      release.resolve(mode);
      let response = await requireValue(reduction, 'Reduction not started');
      if (mode === 'restart') {
        if (response.status !== 503) throw new Error(`Lost acknowledgement returned ${response.status}`);
        service = await createAuthService({ ...options, trustedAccess });
        events.push('auth-instance-restarted');
        response = await request('/consent', { client_id: 'external', scope: [retained] }, controller);
      }
      events.push('consent-http-complete');
      return response;
    },
    inspect,
    async use(jwt, scope) {
      const context = { pool: kernel, deadline: Date.now() + 5000 };
      try {
        const actor = await access.authenticate(jwt, context);
        if (actor.kind !== 'account') throw new Error('Expected account actor');
        return { authenticated: true, allowed: await (await accessCheck(access, actor, scope, resource, context))(kernel),
          epoch: actor.authnEpoch };
      } catch (error) {
        if (!(error instanceof AuthenticationError)) throw error;
        return { authenticated: false, allowed: false, epoch: null };
      }
    },
    async close() {
      release.resolve('resume');
      await reduction;
      await cleanup();
    },
  };
  return driver;
}

/** Deliberately synthetic specification controls. These do not execute product
 * code and must never be reported as native evidence. No cryptographic JWTs. */
export function createReferenceDriver(behavior: 'correct' | 'stale' | 'deny-all' | 'bad-order'): ConsentIssuanceDriver {
  let finished = false;
  let issued = 0;
  const tokens = new Map<string, { identity: Identity; scopes: string[] }>();
  const evidence: Evidence = {
    proof: { reference: 'a'.repeat(64), operationKey: 'b'.repeat(64), digest: 'c'.repeat(64), previousEpoch: 1, receiptId: null },
    receipt: { receiptId: 'reference-receipt', accountId: 'reference-account', minimumAuthnEpoch: '2' },
    account: { accountId: 'reference-account', minimumAuthnEpoch: '2', fenced: false },
    consent: { revision: '1', scopes: [retained, removed] },
    events: ['committed-auth-proof', 'committed-access-receipt', 'paused-before-consent-cas'],
  };
  return {
    startReduction: async () => structuredClone(evidence),
    beginAttempt(identity, scopes) {
      const denied = behavior === 'deny-all' || (behavior !== 'stale' && identity === 'target' && scopes.includes(removed));
      const jwt = denied ? null : `reference-token-${++issued}`;
      if (jwt) tokens.set(jwt, { identity, scopes });
      evidence.events.push('signin-http-start', 'signin-http-complete', 'token-http-complete');
      return { result: Promise.resolve({ signin: new Response('{}', { status: denied ? 401 : 200 }),
        token: denied ? null : new Response(JSON.stringify({ access_token: jwt }), { status: 200 }), jwt }) };
    },
    atGap: async () => 'completed',
    async finish(mode) {
      finished = true;
      evidence.proof.receiptId = evidence.receipt.receiptId;
      evidence.consent = { revision: '2', scopes: [retained] };
      if (mode === 'restart') evidence.events.push('auth-instance-restarted');
      evidence.events.push('consent-http-complete');
      return new Response('{}', { status: 200 });
    },
    async inspect() {
      const copy = structuredClone(evidence);
      if (behavior === 'bad-order') copy.events.reverse();
      return copy;
    },
    async use(jwt, scope) {
      const token = tokens.get(jwt);
      const denied = !token || (finished && behavior !== 'stale' && token.identity === 'target' && token.scopes.includes(removed));
      return { authenticated: !denied, allowed: !denied && token!.scopes.includes(scope), epoch: denied ? null : 2 };
    },
    close: async () => {},
  };
}
