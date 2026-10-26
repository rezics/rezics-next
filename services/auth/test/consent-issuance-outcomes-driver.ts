import { trustedAccessPorts } from './support/trusted-access.ts';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  createBarrierProofVerifier,
  createProvisioningEvidenceVerifier,
  type AuthService,
  type AuthServiceOptions,
  type TrustedAccessPorts,
} from '../src/index.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';
import { routeOf } from '../../kernel/src/route/route.ts';

// Kernel modules compile their SQL against a migrated Access database at import,
// so load them only after the first native fixture exists.
let kernelModules: ReturnType<typeof loadKernel> | undefined;
async function loadKernel(url: string) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
    return {
      ...(await import('../../kernel/src/access/account-data.ts')),
      ...(await import('../../kernel/src/access/auth-barriers.ts')),
      ...(await import('../../kernel/src/access/auth-bindings.ts')),
      ...(await import('../../kernel/src/access/index.ts')),
      ...(await import('../../kernel/src/access/lifecycle.ts')),
      ...(await import('../../kernel/src/access/registration-proof.ts')),
      ...(await import('../../kernel/src/request/access.ts')),
    };
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

// Both actions are native self-grants that registration installs on every actor,
// so consent is the only difference between a retained and a removed scope.
export const retained = 'account:read';
export const removed = 'account:update';
export type Identity = 'target' | 'other-account' | 'other-client';
export type Attempt = { signin: Response; token: Response | null; jwt: string | null };
export type PendingAttempt = { result: Promise<Attempt> };
export type Use = { authenticated: boolean; allowed: boolean; epoch: number | null };
export type Evidence = {
  /** Committed Auth barrier proof row of the reduction. */
  proof: { reference: string; operationKey: string; digest: string; previousEpoch: number; applied: boolean };
  /** Committed native Access fence receipt that Access returned to Auth. */
  receipt: { receiptId: string; accountId: string; minimumAuthnEpoch: string };
  /** Native Access authentication floor of the reducing account: fenced from the barrier until Auth completes it. */
  account: { accountId: string; minimumAuthnEpoch: string; fenced: boolean; receiptId: string | null };
  /** Auth's recorded application of that receipt, absent until the consent CAS commits. */
  applied: { receiptId: string; purpose: string; minimumAuthnEpoch: number } | null;
  /** Exact consent row of the reducing account for the third-party client. */
  consent: { revision: string; scopes: string[] };
  events: string[];
};

/** Transport and durable observations only; outcome policy belongs to the suite.
 * A native implementation forwards the real callbacks and never mints a receipt,
 * alters a JWT, or replaces Access authentication/authorization with a scope check.
 */
export interface ConsentIssuanceDriver {
  /** Start an HTTP /consent reduction (both scopes -> retained only) by the target's
   * own human session; resolve once Access committed its real receipt and before
   * Auth's consent compare-and-set. */
  startReduction(): Promise<Evidence>;
  /** Ordinary password /signin then /token over HTTP for the identity and scopes. */
  beginAttempt(identity: Identity, scopes: string[]): PendingAttempt;
  /** Whether the attempt completed while the reduction is held, or waits on a PostgreSQL lock. */
  atGap(attempt: PendingAttempt): Promise<'completed' | 'blocked'>;
  /** Resume the held reduction, or lose its acknowledgement, restart Auth and retry it. */
  finish(mode: 'resume' | 'restart'): Promise<Response>;
  inspect(): Promise<Evidence>;
  /** Present the JWT to installed Access and check the scope on the actor's own account. */
  use(jwt: string, scope: string): Promise<Use>;
  close(): Promise<void>;
}

function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

const AUTH_APPLICATION = 'consent-outcome-auth';

/** Native composition: real Auth service, Access lifecycle commands, receipts and
 * JWT verification on separate Auth and Access databases. Not production proof of
 * the unavailable general account-workflow host composition. `max` bounds the
 * Auth pool that serves HTTP and both Auth evidence verifiers handed to Access.
 */
export async function createNativeDriver(max = 4): Promise<ConsentIssuanceDriver> {
  const fixture = testDatabase();
  const authUrl = fixture.url;
  const kernelUrl = new URL(fixture.url);
  // One name per fixture: several drivers of one file share a server when the check runs it.
  const accessDatabase = `${decodeURIComponent(kernelUrl.pathname.slice(1))}_access`;
  kernelUrl.pathname = `/${accessDatabase}`;
  const pools: Pool[] = [];
  const open = (url: string, size: number, name: string) => {
    const pool = new Pool({ connectionString: url, max: size, connectionTimeoutMillis: 5000, application_name: name });
    pools.push(pool);
    return pool;
  };
  try {
    const observer = open(authUrl, 1, 'consent-outcome-observer');
    await observer.query(`CREATE DATABASE ${accessDatabase}`);
    migrateKernel(kernelUrl.href);
    const database = open(authUrl, max, AUTH_APPLICATION);
    const kernel = open(kernelUrl.href, 4, 'consent-outcome-access');
    const modules = await (kernelModules ??= loadKernel(kernelUrl.href));
    return await nativeDriver(modules, { database, observer, kernel }, async () => {
      await Promise.all(pools.map((pool) => pool.end()));
      fixture.close();
    });
  } catch (error) {
    await Promise.all(pools.map((pool) => pool.end()));
    fixture.close();
    throw error;
  }
}

async function nativeDriver(
  {
    readAccount,
    createAuthBarrierCapabilities,
    createAuthBindings,
    createAccess,
    createLifecycleInternals,
    createRegistrationProofBindings,
    accessCheck,
    AuthenticationError,
  }: Awaited<ReturnType<typeof loadKernel>>,
  { database, observer, kernel }: { database: Pool; observer: Pool; kernel: Pool },
  cleanup: () => Promise<void>,
): Promise<ConsentIssuanceDriver> {
  const issuer = 'https://consent-outcomes.auth.test';
  const audience = 'https://consent-outcomes.api.test';
  const password = 'native personal consent password';
  const scopes = [retained, removed];
  const events: string[] = [];
  // The Auth host hands Access verifiers over its own Auth database.
  const provisioning = createProvisioningEvidenceVerifier({ database });
  const proofs = createBarrierProofVerifier({ database });
  const witness = createBarrierProofVerifier({ database: observer });
  const lifecycle = createLifecycleInternals({
    pool: kernel,
    routeKey: new Uint8Array(32).fill(61),
    provisioningEvidence: provisioning.resolve,
    recoveryEvidence: async () => null,
  });
  const registration = createRegistrationProofBindings({
    pool: kernel,
    referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(67)]]) },
  });
  const bindings = createAuthBindings({ pool: kernel, ...registration });
  const barriers = createAuthBarrierCapabilities({ lifecycle, proofs });
  const advance = required(barriers.trustedAccess.invalidateAccount, 'Missing native consent barrier');
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'native',
  };
  let input: Parameters<NonNullable<TrustedAccessPorts['invalidateAccount']>>[0] | undefined;
  let hold = true;
  const paused = signal<Evidence>();
  const release = signal<'resume' | 'restart'>();
  const trustedAccess: TrustedAccessPorts = trustedAccessPorts({
    ...bindings,
    async authorizeProvisioning(reference) {
      // The host composes the native registration receipt with Auth's provisioning metadata.
      const approval = await bindings.authorizeProvisioning(reference);
      const receipt = await registration.verifyProvisioningReceipt(reference);
      const account = await readAccount(kernel, routeOf(approval.accountId)!, approval.accountId);
      if (!receipt || !account) throw new Error('Missing committed registration');
      return {
        ...approval,
        receipt: {
          registrationId: receipt.registrationId,
          reservationId: receipt.registrationId,
          expiresAt: receipt.expiresAt,
          authnEpoch: Number(account.minimumAuthnEpoch),
        },
      };
    },
    ...barriers.trustedAccess,
    // Transport of the real callback: observe, forward unchanged, then hold.
    async invalidateAccount(actual) {
      input = actual;
      const visible = await witness.verify(actual.proofReference!, {
        accountId: actual.accountId,
        purpose: 'consent-reduction',
        previousEpoch: actual.previousEpoch,
        operationKey: actual.operationKey!,
      });
      events.push(visible ? 'committed-auth-proof' : 'auth-proof-not-visible');
      const receipt = await advance(actual);
      const durable = await lifecycle.readFenceReceipt(actual.accountId, receipt.receiptId);
      events.push(
        durable?.minimumAuthnEpoch === String(receipt.minimumAuthnEpoch)
          ? 'committed-access-receipt'
          : 'access-receipt-not-durable',
      );
      if (hold) {
        hold = false;
        events.push('paused-before-consent-cas');
        paused.resolve(await inspect());
        if ((await release.promise) === 'restart') {
          events.push('acknowledgement-lost');
          throw new Error('Lost acknowledgement after native commit');
        }
      }
      return receipt;
    },
  });
  const options: AuthServiceOptions = {
    database,
    issuer,
    audience,
    secret: 'native-consent-outcome-secret-with-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess,
  };
  let service: AuthService = await createAuthService(options);
  const request = (path: string, body: unknown, session = '') =>
    service.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie: session },
        body: JSON.stringify(body),
      }),
    );
  await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes });
  await service.internal.registerClient({ clientId: 'external', firstParty: false, scopes });
  await service.internal.registerClient({ clientId: 'unrelated', firstParty: true, scopes });
  const suffix = crypto.randomUUID().slice(0, 8);
  async function person(label: string) {
    const name = `consent-${label}-${suffix}`;
    const accountId = lifecycle.registrationTarget(name);
    const handle = `consent_${label.replaceAll('-', '_')}_${suffix}`;
    const reservation = await lifecycle.reserveHandle({ accountId, handle, key: name });
    const pending = { accountId, handle, key: name, reservationId: reservation.value.reservationId };
    const outcome = await lifecycle.createPending(pending);
    const authorization = required(
      await registration.createProvisioningReference({ input: pending, outcome }),
      'Missing native provisioning reference',
    );
    const result = await service.internal.provisionPassword({
      authorization,
      email: `${handle}@example.test`,
      password,
    });
    const evidence = required(result.provisioningEvidence, 'Missing committed provisioning evidence');
    await lifecycle.claimHandle({ ...pending, key: `${name}-claim`, evidence });
    await lifecycle.activate({ accountId, key: `${name}-activate`, evidence });
    const login = await request('/signin', { account_id: accountId, password, client_id: 'web', scope: scopes });
    if (login.status !== 200) throw new Error(`Native setup sign-in returned ${login.status}`);
    const session = cookie(login);
    const consent = await request('/consent', { client_id: 'external', scope: scopes }, session);
    if (consent.status !== 200) throw new Error(`Native setup consent returned ${consent.status}`);
    return { accountId, session };
  }
  const target = await person('target');
  const other = await person('other');

  async function inspect(): Promise<Evidence> {
    const reference = required(input?.proofReference, 'No consent reduction reached Access');
    const proof = required(
      (
        await observer.query(
          `SELECT reference,operation_key AS "operationKey",digest,previous_epoch AS "previousEpoch",
             applied_at IS NOT NULL AS applied FROM auth_barrier_proof WHERE reference=$1`,
          [reference],
        )
      ).rows[0],
      'Missing committed Auth proof',
    );
    const state = required(await lifecycle.readFenceState(target.accountId), 'Missing native floor');
    const receipt = required(
      state.receiptId ? await lifecycle.readFenceReceipt(target.accountId, state.receiptId) : null,
      'Missing native receipt',
    );
    const applied =
      (
        await observer.query(
          `SELECT receipt_id AS "receiptId",purpose,minimum_authn_epoch AS "minimumAuthnEpoch"
           FROM auth_effect_receipt WHERE receipt_id=$1`,
          [receipt.receiptId],
        )
      ).rows[0] ?? null;
    const consent = required(
      (
        await observer.query('SELECT revision::text,scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
          target.accountId,
          'external',
        ])
      ).rows[0],
      'Missing exact consent',
    );
    return {
      proof,
      receipt: {
        receiptId: receipt.receiptId,
        accountId: receipt.accountId,
        minimumAuthnEpoch: receipt.minimumAuthnEpoch,
      },
      account: {
        accountId: target.accountId,
        minimumAuthnEpoch: state.minimumAuthnEpoch,
        fenced: state.fenced,
        receiptId: state.receiptId,
      },
      applied,
      consent,
      events: [...events],
    };
  }

  const access = createAccess({
    actions: new Map(scopes.map((scope) => [scope, { anonymous: false }])),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async (url, init) => service.handler(new Request(url, init)),
    },
  });
  const completed = new WeakSet<PendingAttempt>();
  let reduction: Promise<Response> | undefined;
  const reduce = () => request('/consent', { client_id: 'external', scope: [retained] }, target.session);
  return {
    async startReduction() {
      if (reduction) throw new Error('Reduction already started');
      reduction = reduce();
      return Promise.race([
        paused.promise,
        reduction.then((response) => {
          throw new Error(`Reduction returned ${response.status} before the committed Access receipt`);
        }),
      ]);
    },
    beginAttempt(identity, selected) {
      const attempt: PendingAttempt = {
        result: (async () => {
          events.push('signin-http-start');
          const signin = await request('/signin', {
            account_id: identity === 'other-account' ? other.accountId : target.accountId,
            password,
            client_id: identity === 'other-client' ? 'unrelated' : 'external',
            scope: selected,
          });
          events.push('signin-http-complete');
          if (!signin.ok) return { signin, token: null, jwt: null };
          const token = await request('/token', {}, cookie(signin));
          events.push('token-http-complete');
          const jwt = token.ok ? ((await token.clone().json()) as { access_token: string }).access_token : null;
          return { signin, token, jwt };
        })(),
      };
      const settle = () => void completed.add(attempt);
      attempt.result.then(settle, settle);
      return attempt;
    },
    async atGap(attempt) {
      // An actual PostgreSQL lock wait of an Auth backend, never elapsed-time inference.
      // The held reduction is idle between its transactions, so a waiter is the attempt.
      const deadline = Date.now() + 20_000;
      while (!completed.has(attempt)) {
        const waits = await observer.query(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1
             AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`,
          [AUTH_APPLICATION],
        );
        if (waits.rowCount) return 'blocked';
        if (Date.now() > deadline) throw new Error('Attempt neither completed nor waited on a PostgreSQL lock');
        await setImmediate();
      }
      return 'completed';
    },
    async finish(mode) {
      const held = required(reduction, 'Reduction not started');
      release.resolve(mode);
      let response = await held;
      if (mode === 'restart') {
        if (response.status !== 503) throw new Error(`Lost acknowledgement returned ${response.status}`);
        service = await createAuthService(options);
        events.push('auth-instance-restarted');
        response = await reduce();
      }
      events.push('consent-http-complete');
      return response;
    },
    inspect,
    async use(jwt, scope) {
      const context = { pool: kernel, deadline: Date.now() + 5000 };
      let actor;
      try {
        actor = await access.authenticate(jwt, context);
      } catch (error) {
        if (error instanceof AuthenticationError) return { authenticated: false, allowed: false, epoch: null };
        throw error;
      }
      if (actor.kind !== 'account') throw new Error('Expected an account actor');
      const resource = { route: required(routeOf(actor.accountId), 'Unroutable actor'), id: actor.accountId };
      const check = await accessCheck(access, actor, scope, resource, context);
      return { authenticated: true, allowed: await check(kernel), epoch: actor.authnEpoch };
    },
    async close() {
      release.resolve('resume');
      await reduction?.catch(() => undefined);
      await cleanup();
    },
  };
}

/** Deliberately synthetic specification controls. They execute no product code,
 * mint no cryptographic JWT, and must never be reported as native evidence. */
export function createReferenceDriver(behavior: 'correct' | 'stale' | 'deny-all' | 'bad-order'): ConsentIssuanceDriver {
  let finished = false;
  let issued = 0;
  const tokens = new Map<string, { identity: Identity; scopes: string[] }>();
  const evidence: Evidence = {
    proof: {
      reference: 'a'.repeat(64),
      operationKey: 'b'.repeat(64),
      digest: 'c'.repeat(64),
      previousEpoch: 1,
      applied: false,
    },
    receipt: { receiptId: 'reference-receipt', accountId: 'reference-account', minimumAuthnEpoch: '2' },
    account: { accountId: 'reference-account', minimumAuthnEpoch: '2', fenced: true, receiptId: 'reference-receipt' },
    applied: null,
    consent: { revision: '2', scopes: [retained, removed] },
    events: ['committed-auth-proof', 'committed-access-receipt', 'paused-before-consent-cas'],
  };
  return {
    startReduction: async () => structuredClone(evidence),
    beginAttempt(identity, scopes) {
      // The reducing account is fenced until the reduction completes, whatever the client.
      const fenced = !finished && identity !== 'other-account';
      const denied =
        behavior === 'deny-all' ||
        fenced ||
        (behavior !== 'stale' && identity === 'target' && scopes.includes(removed));
      const jwt = denied ? null : `reference-token-${++issued}`;
      if (jwt) tokens.set(jwt, { identity, scopes });
      evidence.events.push('signin-http-start', 'signin-http-complete');
      if (!denied) evidence.events.push('token-http-complete');
      return {
        result: Promise.resolve({
          signin: new Response(denied ? JSON.stringify({ error: 'authentication_denied' }) : '{}', {
            status: denied ? 401 : 200,
          }),
          token: denied ? null : new Response(JSON.stringify({ access_token: jwt }), { status: 200 }),
          jwt,
        }),
      };
    },
    atGap: async () => 'completed',
    async finish(mode) {
      finished = true;
      evidence.proof.applied = true;
      evidence.account.fenced = false;
      evidence.applied = { receiptId: evidence.receipt.receiptId, purpose: 'consent-reduction', minimumAuthnEpoch: 2 };
      evidence.consent = { revision: '3', scopes: [retained] };
      if (mode === 'restart')
        evidence.events.push(
          'acknowledgement-lost',
          'auth-instance-restarted',
          'committed-auth-proof',
          'committed-access-receipt',
        );
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
      const stale = finished && behavior !== 'stale' && token?.identity === 'target' && token.scopes.includes(removed);
      if (!token || stale) return { authenticated: false, allowed: false, epoch: null };
      return { authenticated: true, allowed: token.scopes.includes(scope), epoch: 2 };
    },
    close: async () => {},
  };
}
