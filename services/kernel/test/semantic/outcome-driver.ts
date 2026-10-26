import {
  createAuthHost,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { releaseDigest } from '@rezics/definitions';
import { bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { exportJWK, generateKeyPair } from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { HttpResponse, Persona, Release, SemanticDriver } from '../../../../specs/semantic-driver.ts';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { setupPresentation } from '../../src/presentation/setup.ts';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';

type Account = { accountId: string; bearer: string };
type AuthHost = Awaited<ReturnType<typeof createAuthHost>>;

const password = 'semantic outcome registration password with enough entropy';
const clientId = 'semantic-outcomes';
const kernelRoot = resolve(import.meta.dir, '../..');
const authMigrations = fileURLToPath(new URL('../../../auth/db/migrations', import.meta.url));

function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

function databaseUrl(source: URL, name: string): string {
  const value = new URL(source);
  value.pathname = `/${name}`;
  return value.href;
}

async function jsonResponse(response: Response): Promise<HttpResponse> {
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

export async function createSemanticDriver(): Promise<SemanticDriver> {
  const source = new URL(required(process.env.DATABASE_URL, 'DATABASE_URL must name the migrated test database'));
  const template = decodeURIComponent(source.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(template)) throw new Error('Unsafe template database name');

  const suffix = randomUUID().replaceAll('-', '');
  const kernelName = `semantic_${suffix}`;
  const authName = `semantic_auth_${suffix}`;
  const owner = new Pool({ connectionString: databaseUrl(source, 'postgres'), max: 1 });
  const owned: string[] = [];
  let pool: Pool | undefined;
  let authPool: Pool | undefined;
  let authServer: ReturnType<typeof Bun.serve> | undefined;
  let host: AuthHost | undefined;
  let relays: ReturnType<typeof startRelays> | undefined;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await relays?.stop().catch(() => {});
      await host?.stop().catch(() => {});
      await authServer?.stop(true).catch(() => {});
      await authPool?.end().catch(() => {});
      await pool?.end().catch(() => {});
      for (const name of owned.reverse()) {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
      }
    } finally {
      await owner.end().catch(() => {});
    }
  };

  try {
    await owner.query(`CREATE DATABASE "${kernelName}" TEMPLATE "${template}"`);
    owned.push(kernelName);
    await owner.query(`CREATE DATABASE "${authName}"`);
    owned.push(authName);

    const kernelUrl = databaseUrl(source, kernelName);
    const authUrl = databaseUrl(source, authName);
    migrateAuth(authUrl, authMigrations);
    pool = createPool(kernelUrl);
    authPool = new Pool({ connectionString: authUrl, max: 10 });
    authPool.on('error', () => {});
    authPool.on('connect', (client) => client.on('error', () => {}));

    const routeKey = randomBytes(32);
    const sessionKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const signingKey = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: `semantic-${suffix}`,
      alg: 'ES256',
    };
    let service!: AuthService;
    authServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => service.handler(request),
    });
    const issuer = `http://127.0.0.1:${authServer.port}`;
    const audience = 'https://semantic.api.rezics.test';
    let access!: ReturnType<typeof createAccess>;
    const app = createKernel({
      pool,
      routeKey,
      tokens: sessionKeys,
      writeRate: createWriteRateLimiter({
        secret: 'semantic-outcome-write-rate-secret-with-at-least-32-bytes',
      }),
      access(config) {
        access = createAccess({
          ...config,
          auth: {
            issuer,
            audience,
            jwksUrl: `${issuer}/.well-known/jwks.json`,
          },
        });
        return access;
      },
    });

    const scopes = [...actionCatalogue(app).keys()].filter((scope) => scope !== 'media:complete');
    const proofs = createNativeWorkflowProofPorts({ database: authPool });
    const registration = createRegistrationProofBindings({ pool, referenceKeys: sessionKeys });
    const provisioning = createProvisioningEvidenceVerifier({ database: authPool });
    const lifecycle = createLifecycleInternals({
      pool,
      routeKey,
      provisioningEvidence: (evidence) => provisioning.resolve(evidence),
      recoveryEvidence: async () => null,
    });
    const registrationPorts = {
      ...lifecycle,
      async createPending(input: Parameters<typeof lifecycle.createPending>[0]) {
        const outcome = await lifecycle.createPending(input);
        const pending = { accountId: input.accountId, reservationId: input.reservationId };
        if (!(await proofs.pendingReference(pending))) {
          const reference = await registration.createProvisioningReference({ input, outcome });
          if (!reference) throw new Error('Missing native registration reference');
          await proofs.recordPending({ ...pending, reference });
        }
        return outcome;
      },
      async provisioningReference(input: { accountId: string; reservationId: string }) {
        const reference = await proofs.pendingReference(input);
        if (!reference) throw new Error('Missing persisted registration reference');
        return reference;
      },
      provisioningEvidence: (input: { accountId: string; reservationId: string }) => proofs.provisioningEvidence(input),
    };
    host = await createAuthHost({
      database: authPool,
      systemDatabasePool: authPool,
      issuer,
      audience,
      secret: 'semantic-outcome-auth-secret-with-at-least-32-bytes',
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      trustedAccess: createAuthBindings({
        pool,
        ...registration,
        verifyPendingIdentity: registration.verifyNativePendingIdentity,
      }),
      access: registrationPorts,
      stagingKey: randomBytes(32),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: `semantic-${suffix}`,
    });
    service = host.service;
    await service.internal.registerClient({ clientId, firstParty: true, scopes });
    await host.start();

    async function issue(email: string): Promise<string> {
      const signed = await service.handler(
        new Request(`${issuer}/signin`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, client_id: clientId, scope: scopes }),
        }),
      );
      if (signed.status !== 200) throw new Error(`Semantic fixture sign-in failed: ${signed.status}`);
      const cookie = signed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const issued = await service.handler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: '{}',
        }),
      );
      if (issued.status !== 200) throw new Error(`Semantic fixture token issuance failed: ${issued.status}`);
      return ((await issued.json()) as { access_token: string }).access_token;
    }

    async function person(name: string): Promise<Account> {
      const email = `${name}-${suffix}@semantic.test`;
      const result = await host!.workflows.register({
        key: `${name}-${suffix}`,
        handle: `${name}_${suffix}`,
        email,
        password,
      });
      return { accountId: result.accountId, bearer: await issue(email) };
    }

    const governor = await person('governor');
    const accounts = {
      editor: await person('editor'),
      acceptor: await person('acceptor'),
      steward: await person('steward'),
      suspended: await person('suspended'),
    } satisfies Record<Exclude<Persona, 'anonymous'>, Account>;

    await setupSemantic(pool, bundledRelease);
    await setupPresentation(pool);

    const bootstrap = Bun.spawn(
      [process.execPath, 'scripts/bootstrap-governance.ts', '--account', governor.accountId],
      {
        cwd: kernelRoot,
        env: { ...process.env, DATABASE_URL: kernelUrl },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [bootstrapCode, bootstrapOut, bootstrapErr] = await Promise.all([
      bootstrap.exited,
      new Response(bootstrap.stdout).text(),
      new Response(bootstrap.stderr).text(),
    ]);
    if (bootstrapCode !== 0)
      throw new Error(`Governance bootstrap exited ${bootstrapCode}: ${bootstrapOut}${bootstrapErr}`);

    const sessions = new Map<Exclude<Persona, 'anonymous'>, string>();
    async function send(
      account: Account | null,
      method: 'GET' | 'POST' | 'PUT',
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
      persona?: Exclude<Persona, 'anonymous'>,
    ): Promise<HttpResponse> {
      const requestHeaders = new Headers(headers);
      if (account) requestHeaders.set('authorization', `Bearer ${account.bearer}`);
      if (persona && sessions.has(persona)) requestHeaders.set('rezics-session-token', sessions.get(persona)!);
      if (body !== undefined) requestHeaders.set('content-type', 'application/json');
      const response = await app.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: requestHeaders,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const session = response.headers.get('rezics-session-token');
      if (persona && session) sessions.set(persona, session);
      return jsonResponse(response);
    }

    const key = () => `"${randomUUID()}"`;
    async function grantAccount(account: Account, actions: string[], resourceId = GLOBAL_CONTEXT) {
      const route = resourceId === GLOBAL_CONTEXT ? 0 : routeOf(resourceId);
      if (route === null) throw new Error(`Cannot grant an unroutable resource: ${resourceId}`);
      const response = await send(
        governor,
        'POST',
        '/v1/grants',
        {
          resource: { route, id: resourceId },
          subject: { kind: 'account', id: account.accountId },
          actions,
          valid: '(,)',
        },
        { 'Idempotency-Key': key() },
      );
      if (response.status !== 201)
        throw new Error(`Grant administration failed: ${response.status}: ${JSON.stringify(response.body)}`);
    }

    await grantAccount(accounts.editor, ['subject:create', 'statement:propose', 'context:create']);
    await grantAccount(accounts.acceptor, ['context:accept', 'context:adopt', 'subject:merge']);
    await grantAccount(accounts.steward, ['definitions:publish', 'definitions:activate']);
    await grantAccount(accounts.suspended, [
      'subject:create',
      'statement:propose',
      'context:create',
      'context:accept',
      'context:adopt',
      'subject:merge',
    ]);

    const boundary = { pool, deadline: Date.now() + 10_000 };
    await createSuspensionCommands({ pool, access, clock: () => new Date() }).suspend(
      { ...boundary, actor: await access.authenticate(governor.bearer, boundary) },
      { accountId: accounts.suspended.accountId, key: randomUUID() },
    );

    relays = startRelays(pool, [linkProjection(pool)], { intervalMs: 25 });

    const driver: SemanticDriver = {
      globalContext: GLOBAL_CONTEXT,
      request(persona, method, path, body, headers) {
        if (persona === 'anonymous') return send(null, method, path, body, headers);
        return send(accounts[persona], method, path, body, headers, persona);
      },
      async compile(root, schemas, presentation) {
        const bundled = bundledSources();
        const mergedPresentation = { ...bundled.presentation };
        for (const [language, additions] of Object.entries(presentation)) {
          const base = Bun.YAML.parse(mergedPresentation[language] ?? '{}') as {
            types?: Record<string, string>;
            properties?: Record<string, string>;
          };
          mergedPresentation[language] = Bun.YAML.stringify({
            types: { ...(base.types ?? {}), ...(additions.types ?? {}) },
            properties: { ...(base.properties ?? {}), ...(additions.properties ?? {}) },
          });
        }
        const release = await compileCatalogue({
          root,
          schemas: { ...bundled.schemas, ...schemas },
          presentation: mergedPresentation,
          contexts: bundled.contexts,
          filters: bundled.filters,
        });
        return { digest: releaseDigest(release), release: release as unknown as Release };
      },
      async grant(persona, actions, resourceId) {
        if (persona === 'anonymous') throw new Error('Anonymous is not an account grant recipient');
        await grantAccount(accounts[persona], actions, resourceId);
      },
      async projection(state) {
        if (state === 'paused') await relays!.pause();
        else relays!.resume();
      },
      inspect: {
        async revisions(subjectId) {
          const route = routeOf(subjectId);
          if (route === null) return [];
          const rows = await pool!.query<{
            revision: number;
            partition: number;
            transaction_id: string;
          }>(
            `SELECT revision, route >> 4 AS partition,
                    recorded_transaction_id::text AS transaction_id
               FROM semantic.revision
              WHERE route=$1 AND subject_id=$2
              ORDER BY revision`,
            [route, subjectId],
          );
          return rows.rows.map((row) => ({
            revision: Number(row.revision),
            partition: Number(row.partition),
            transactionId: row.transaction_id,
          }));
        },
      },
      close,
    };
    return driver;
  } catch (error) {
    await close();
    throw error;
  }
}
