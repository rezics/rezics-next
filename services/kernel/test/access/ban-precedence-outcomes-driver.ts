import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import type {
  BanPrecedenceDriver,
  BanPrecedenceFixture,
  Principal,
  ReadSurface,
} from '../../../../specs/ban-precedence-driver.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import { startConsentServer, type ConsentServer } from '../community/membership-fixture.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { createPersonas, type Persona } from '../support/personas.ts';
import { registerTestClient, testKernel, testRouteKey, testTokens } from '../support/test-kernel.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { cookies, nativeFixture, password } from './native-account-bindings-fixture.ts';

async function checked(response: Response, operation: string): Promise<Response> {
  if (!response.ok) throw new Error(`${operation}: ${response.status} ${await response.clone().text()}`);
  return response;
}
async function json<T>(response: Response, operation: string): Promise<T> {
  return (await checked(response, operation)).json() as Promise<T>;
}
const principal = (person: Persona): Principal => ({ accountId: person.accountId, credential: person.bearer });
const resource = (id: string) => ({ route: routeOf(id)!, id });

/** Each factory owns its migrated kernel clone, native Auth and kernel worker. */
export async function createBanPrecedenceDriver(): Promise<BanPrecedenceDriver> {
  const source = new URL(process.env.DATABASE_URL!);
  const template = source.pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+$/.test(template)) throw new Error('Unsafe kernel template database name');
  const name = `ban_precedence_${crypto.randomUUID().replaceAll('-', '')}`;
  const maintenance = new URL(source);
  maintenance.pathname = '/postgres';
  const admin = new Pool({ connectionString: maintenance.href, max: 1 });
  let created = false;
  let pool: ReturnType<typeof createPool> | undefined;
  let auth: Awaited<ReturnType<typeof nativeFixture>> | undefined;
  let work: WorkClient | undefined;
  let consent: ConsentServer | undefined;
  let worker: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let diagnostics: Promise<unknown> | undefined;
  let output = '';
  let closing: Promise<void> | undefined;

  async function stopWorker() {
    if (!worker) return;
    if (worker.exitCode === null) worker.kill();
    await worker.exited;
    await diagnostics;
    worker = undefined;
  }
  const close = () =>
    (closing ??= (async () => {
      try {
        await stopWorker();
      } finally {
        try {
          await consent?.close();
        } finally {
          try {
            await work?.close();
          } finally {
            try {
              await auth?.close();
            } finally {
              try {
                await pool?.end();
              } finally {
                try {
                  if (created) await dropTestDatabase(admin, name);
                } finally {
                  await admin.end();
                }
              }
            }
          }
        }
      }
    })());

  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    created = true;
    source.pathname = `/${name}`;
    const database = createPool(source.href);
    pool = database;
    const native = await nativeFixture(database);
    auth = native;
    const service = native.host.service;
    const client = await createWorkClient(source.href, database);
    work = client;
    const kernel = testKernel({
      pool: database,
      workClient: client,
      requestDeadlineMs: 120_000,
      auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
      writeRate: createWriteRateLimiter({
        secret: 'ban-precedence-native-write-rate-secret',
        overrides: JSON.stringify({
          'new-account': { write: { maximum: 100000, seconds: 86400 } },
        }),
      }),
    });
    function transport(credential: string | null, path: string, init?: RequestInit) {
      const headers = new Headers(init?.headers);
      if (credential !== null) headers.set('authorization', `Bearer ${credential}`);
      return kernel.handle(new Request(`https://kernel.test${path}`, { ...init, headers }));
    }
    function command(credential: string, method: string, path: string, body?: unknown, head?: string) {
      return transport(credential, path, {
        method,
        headers: {
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(head === undefined ? {} : { 'if-match': JSON.stringify(head) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    await bootstrapRelease(database, bundledRelease);
    const people = await createPersonas(kernel, { version: 1, pool: database, auth: native });
    const owner = people.staff.bearer;
    // The organization's native owner is the banned member in every grant variant.
    const member = principal(people.orgOwner);
    const reader = principal(people.bob);
    const outsider = principal(people.alice);
    const scopes = [...new Set([...actionCatalogue(kernel).keys(), ...LIFECYCLE_ACTIONS.keys()])]
      .filter((scope) => scope !== 'media:complete')
      .sort();
    const clientId = `ban_precedence_${crypto.randomUUID()}`;
    await registerTestClient(service, { clientId, firstParty: true, scopes });
    const login = await checked(
      await native.request('/signin', {
        account_id: people.operator.accountId,
        password,
        client_id: clientId,
        scope: scopes,
      }),
      'Operator sign-in',
    );
    const openingKey = crypto.randomUUID();
    const operatorToken = await json<{ access_token: string }>(
      await native.request('/token', {}, cookies(login)),
      'Operator token',
    );
    const opening = {
      kind: 'opening' as const,
      operatorAccountId: people.operator.accountId,
      subjectAccountId: people.software.accountId,
      authorization: 'request',
    };
    const approval = await native
      .approval()
      .approve(
        operatorToken.access_token,
        { operationKey: openingKey, operation: opening },
        { pool: database, deadline: Date.now() + 30_000 },
      );
    const opened = await checked(
      await native.host.workflows.openOperatorSession({
        ...opening,
        key: openingKey,
        authorization: approval.reference,
        headers: cookies(login),
      }),
      'Automated actor session',
    );
    const delegationContext = { pool: database, deadline: Date.now() + 30_000 };
    const assignment = await createDelegationCommands({
      pool: database,
      access: native.access,
      action: 'account:manage',
    }).create(
      { ...delegationContext, actor: await native.access.authenticate(member.credential, delegationContext) },
      {
        principalId: member.accountId,
        assignedActorId: people.software.accountId,
        requestId: newId(routeOf(member.accountId)!),
        valid: '(,)',
        key: crypto.randomUUID(),
      },
    );
    const issued = await json<{ access_token: string }>(
      await native.request('/token', { requested_by: assignment.value.requestedBy }, cookies(opened)),
      'Delegated token',
    );
    const delegate = { accountId: people.software.accountId, credential: issued.access_token };

    const temporary = resolve(import.meta.dir, '../../../../.temp');
    await mkdir(temporary, { recursive: true });
    const consentReader = createCurrentConsentReader({ database: native.authPool });
    consent = await startConsentServer(
      async (input) => (await consentReader.readCurrentConsent(input))?.scopes ?? null,
      temporary,
    );
    const workerEnv = workerTestEnv({
      ...process.env,
      DATABASE_URL: source.href,
      KERNEL_ROUTE_KEY: Buffer.from(testRouteKey()).toString('base64url'),
      KERNEL_SESSION_KEYS: `1:${Buffer.from(testTokens().keys.get(1)!).toString('base64url')}`,
      KERNEL_EXECUTOR_ID: name,
      KERNEL_WORKER_POOL_SIZE: '6',
      AUTH_ISSUER: service.verifier.issuer,
      AUTH_AUDIENCE: service.verifier.audience,
      AUTH_JWKS_URL: service.verifier.jwksUrl,
      STRIPE_SECRET_KEY: 'sk_test_ban_precedence',
      STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
      CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
      OPENSEARCH_URL: '',
      ...consent.env,
    });
    async function startWorker() {
      output = '';
      worker = Bun.spawn(['bun', 'src/worker.ts'], {
        cwd: resolve(import.meta.dir, '../..'),
        env: workerEnv,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
        output += decoder.decode();
      };
      diagnostics = Promise.all([pump(worker.stdout), pump(worker.stderr)]);
      const deadline = Date.now() + 90_000;
      while (!output.includes('Worker ready')) {
        if (worker.exitCode !== null) throw new Error(`Kernel worker exited ${worker.exitCode}: ${output}`);
        if (Date.now() >= deadline) throw new Error(`Kernel worker did not become ready: ${output}`);
        await Bun.sleep(20);
      }
    }

    const boards = new Map<BanPrecedenceFixture, string>();
    const grant = (id: string, subject: unknown, actions: string[], revoke = false) =>
      command(owner, 'POST', revoke ? '/v1/grants:revoke' : '/v1/grants', {
        resource: resource(id),
        subject,
        actions,
        valid: '(,)',
      });
    const account = (person: Principal) => ({ kind: 'account', id: person.accountId });
    return {
      async fixture() {
        const { context } = await json<{ context: { id: string } }>(
          await command(owner, 'POST', '/v1/contexts', { labels: { en: 'Ban precedence Context' } }),
          'Create Context',
        );
        const { space } = await json<{ space: { spaceId: string } }>(
          await command(owner, 'POST', '/v1/spaces', { title: 'Ban precedence host' }),
          'Create Space',
        );
        const { realm } = await json<{ realm: { realmId: string; headRevisionId: string } }>(
          await command(owner, 'POST', '/v1/realms', {
            spaceId: space.spaceId,
            title: 'Ban precedence Realm',
            visibility: 'public',
            contextId: context.id,
          }),
          'Create Realm',
        );
        const { subject: scheme } = await json<{ subject: { id: string } }>(
          await command(owner, 'POST', '/v1/subjects', {
            type: 'skos:ConceptScheme',
            labels: { en: 'Ban precedence boards' },
          }),
          'Create scheme',
        );
        await checked(
          await command(
            owner,
            'PUT',
            `/v1/realms/${realm.realmId}/boardScheme`,
            { schemeId: scheme.id },
            realm.headRevisionId,
          ),
          'Set board scheme',
        );
        await startWorker();
        try {
          const joined = await json<{ workflowId: string }>(
            await command(member.credential, 'POST', `/v1/realms/${realm.realmId}/membership`),
            'Join Realm',
          );
          await client.retrieveWorkflow(joined.workflowId).getResult();
        } finally {
          // Leave removal queued after ban, so the next GET observes the commit itself.
          await stopWorker();
        }
        async function surface(visibility: 'published' | 'protected'): Promise<ReadSurface> {
          const { subject: concept } = await json<{ subject: { id: string } }>(
            await command(owner, 'POST', '/v1/subjects', {
              type: 'skos:Concept',
              labels: { en: `Ban precedence ${visibility}` },
              statements: {
                'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
              },
            }),
            'Create board concept',
          );
          const { board } = await json<{ board: { id: string } }>(
            await command(owner, 'POST', `/v1/realms/${realm.realmId}/boards`, {
              conceptId: concept.id,
              title: `Ban precedence ${visibility}`,
              visibility,
            }),
            'Create board',
          );
          await checked(await grant(board.id, account(member), ['board:read', 'thread:create']), 'Author setup grant');
          const { thread } = await json<{ thread: { id: string; firstPost: { id: string } } }>(
            await command(member.credential, 'POST', '/v1/threads', {
              boardId: board.id,
              title: `Ban precedence ${visibility} thread`,
              body: fromPlainText(`Past contribution ${crypto.randomUUID()}`),
              licence: 'MIT',
              subjectIds: [],
              visibility: 'published',
            }),
            'Create member contribution',
          );
          await checked(await grant(board.id, account(member), ['board:read'], true), 'End author setup read grant');
          if (visibility === 'protected')
            await checked(await grant(board.id, account(reader), ['board:read']), 'Reader grant');
          return {
            board: { path: `/v1/boards/${board.id}`, marker: board.id },
            thread: { path: `/v1/threads/${thread.id}`, marker: thread.id },
            post: { path: `/v1/posts/${thread.firstPost.id}`, marker: thread.firstPost.id },
            threads: { path: `/v1/boards/${board.id}/threads?sort=newest`, marker: thread.id },
            posts: { path: `/v1/threads/${thread.id}/posts`, marker: thread.firstPost.id },
          };
        }
        const privateReads = await surface('protected');
        const publicReads = await surface('published');
        const fixture: BanPrecedenceFixture = {
          realmId: realm.realmId,
          member,
          delegate,
          reader,
          outsider,
          privateReads,
          publicReads,
          pastPosts: { public: publicReads.post, private: privateReads.post },
        };
        boards.set(fixture, privateReads.board.marker);
        return fixture;
      },
      async grantRead(fixture, kind) {
        const boardId = boards.get(fixture);
        if (!boardId) throw new Error('Fixture does not belong to this driver');
        if (kind === 'organization')
          return grant(boardId, { kind: 'organization', id: people.organization.accountId, role: 'owner' }, [
            'board:read',
          ]);
        if (kind === 'delegation') {
          await checked(
            await grant(boardId, account(fixture.member), ['board:read']),
            'Delegating principal read grant',
          );
          return grant(boardId, account(fixture.delegate), ['board:read']);
        }
        return grant(boardId, account(fixture.member), ['board:read']);
      },
      ban: (fixture, reason) =>
        command(owner, 'PUT', `/v1/realms/${fixture.realmId}/bans/${fixture.member.accountId}`, { reason }),
      lift: (fixture) => command(owner, 'DELETE', `/v1/realms/${fixture.realmId}/bans/${fixture.member.accountId}`),
      request: (credential, path) => transport(credential, path),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
