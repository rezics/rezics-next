import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { YAML } from 'bun';
import { startAccount, freePort, qaEnvironment } from './account-boundary-fixture.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessPlatformAdministrators } from '../../../services/main/src/modules/access/platform-administrator.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { AccessGrants } from '../../../services/main/src/modules/access/grants.ts';
import { grantPlatformUse } from '../fixtures/platform-grant.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import {
  readExportPlan,
  ExportSourceNotFound,
} from '../../../services/main/src/modules/export/readers.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { AdmittedTypeStore } from '../../../services/main/src/modules/types/store.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import { PostgresRateLimitStore } from '../../../services/main/src/modules/rate-limit/store.ts';
import { RATE_LIMIT_V1 } from '../../../services/main/src/modules/rate-limit/budgets.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AliasRegistry } from '../../../services/main/src/modules/address/registry.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import type { BootstrapPlan } from '../../../scripts/ops/bootstrap/plan.ts';
import type { BootstrapResult } from '../../../scripts/ops/bootstrap/execute.ts';
import type { Journal as JournalState } from '../../../scripts/ops/bootstrap/journal.ts';

const root = resolve(import.meta.dir, '../../..');

test('G-724: first administrator is granted once, replay/other configuration is ignored, and empty API bootstrap verifies and recovers', async () => {
  const qa = qaEnvironment();
  const namespace = `g724-${randomUUID().slice(0, 8)}`;
  const folder = join(root, '.temp/bootstrap', namespace);
  const accessPool = new Pool({ connectionString: qa.accessDatabaseUrl });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL! });
  const account = await startAccount({
    pool: { connectionString: Bun.env.ACCOUNT_DATABASE_URL! },
    secret: qa.secret,
    resource: qa.resource,
  });
  let main: ReturnType<typeof createMainApp> | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  let child: ChildProcess | undefined;
  try {
    await migrateContent(contentPool);
    expect(
      (
        await accessPool.query(
          `SELECT e.receipt FROM access.platform_grant_episode e
        WHERE e.permission = 'platform:grant'`,
        )
      ).rowCount,
    ).toBe(0);
    const administrators = new AccessPlatformAdministrators(accessPool);
    const principalsBefore = (await accessPool.query('SELECT id FROM access.principal')).rowCount;
    await expect(
      administrators.designateFirst(account.issuer, 'mistyped-account-subject'),
    ).rejects.toThrow('existing active');
    expect((await accessPool.query('SELECT id FROM access.principal')).rowCount).toBe(
      principalsBefore,
    );
    expect(
      (
        await accessPool.query(
          'SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2',
          [account.issuer, 'mistyped-account-subject'],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await accessPool.query(
          `SELECT e.receipt FROM access.platform_grant_episode e
        WHERE e.permission = 'platform:grant'`,
        )
      ).rowCount,
    ).toBe(0);
    // Account fixture stands in for completed email verification, not Access authority.
    await account.pool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [
      account.operator.id,
    ]);

    const scopes =
      'openid access:grant agent:create space:create zone:edit collection:edit semantic:read work:create work:edit work:read source:intake owner:operate classification:define rating:configure';
    const verifierClient = await account.workloadApp('Bootstrap token verifier', ['work:read']);
    const client = await account.nativeApp('Launch operator', scopes);
    // source:intake is a closed-group scope. Third-party consent drops it, so
    // intake would answer account_assertion_denied. The launch operator is first-party.
    await account.pool.query(
      `INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [client.client_id],
    );
    const token = (await account.issue(client.client_id, account.operator, scopes)).access_token;
    expect(String((await account.introspect(verifierClient, token)).scope ?? '').split(' ')).toContain(
      'source:intake',
    );
    const verifier = new AccountAssertionVerifier(account.verifierConfig(verifierClient));
    const fuseki = new FusekiClient(
      qa.fusekiUrl,
      Bun.env.FUSEKI_MAINTENANCE_TOKEN!,
      Bun.env.FUSEKI_COMMAND_TOKEN!,
    );
    const objects = (prefix: string) =>
      new S3ImmutableObjects({
        endpoint: Bun.env.MAIN_S3_ENDPOINT!,
        bucket: Bun.env.MAIN_S3_BUCKET!,
        region: Bun.env.MAIN_S3_REGION!,
        accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
        secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
        prefix,
      });
    const workObjects = objects('semantic/work/');
    const structureObjects = objects('semantic/structure/');
    await workObjects.initialize();
    await structureObjects.initialize();
    const env = {
      addresses: new AliasRegistry(accessPool),
      fuseki,
      lineage: { dataEpoch: qa.dataEpoch, routingEpoch: qa.routingEpoch },
      objectDirectory: qa.objectDirectory,
      workObjects,
      structureObjects,
    };
    const access = new AccessAdmissionRegistry(accessPool);
    access.configureBaseline(fuseki);
    const grants = new AccessGrants(accessPool);
    const rights = new RightsStore(contentPool, accessPool);
    const intake = new SourceIntakeStore(contentPool);
    intake.setRawRetentionGate((provider, scope) => rights.rawRetentionPermitted(provider, scope));
    const limitOptions = {
      secret: Bun.env.FUSEKI_TITLE_ADMISSION_KEY!,
      serviceClientIds: new Set<string>(),
      trustedProxyPeers: new Set<string>(),
      clientIpHeader: 'x-rezics-client-ip',
    };
    const limits = new PostgresRateLimitStore(accessPool, limitOptions);

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const startMain = () =>
      createMainApp(fuseki, {
        environment: env,
        account: verifier,
        access,
        grants,
        // Non-public routes stay closed until this owner reads the designated grants.
        platformAccess: new AccessExposure(accessPool),
        agentProvisioning: new AgentProvisioning(accessPool, env),
        actingContexts: new AccessActingContexts(accessPool, env),
        structureObjects,
        catalogueIntake: new CatalogueIntakeStore(accessPool, env),
        sourceIntake: intake,
        types: new AdmittedTypeStore(accessPool),
        rateLimit: { options: limitOptions, store: limits, budgets: RATE_LIMIT_V1 },
      }).listen({ hostname: '127.0.0.1', port });
    main = startMain();
    const before = await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ?work a <https://schema.org/CreativeWork> } }`);
    expect(before.boolean).toBe(false);
    const agentResponse = await fetch(`${origin}/v1/agents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': `${namespace}:operator`,
      },
      body: JSON.stringify({
        profile: 'agent-provision-v1',
        kind: 'person',
        displayName: 'Launch operator',
      }),
    });
    expect(agentResponse.status, await agentResponse.clone().text()).toBe(201);
    const agent = (await agentResponse.json()) as { agent: string };
    // Match deployment: provision first, then stop Main, consume operator
    // configuration at startup and build a fresh request/rate-limit lifecycle.
    await main.stop(true);
    main = undefined;
    const logs: string[] = [];
    const first = await administrators.designateFirst(
      account.issuer,
      account.operator.id,
      (message) => logs.push(message),
    );
    expect(first.status).toBe('granted');
    const replay = await administrators.designateFirst(
      account.issuer,
      account.operator.id,
      (message) => logs.push(message),
    );
    const ignored = await administrators.designateFirst(
      account.issuer,
      'another-account-subject',
      (message) => logs.push(message),
    );
    expect(replay).toEqual({ status: 'ignored', receipt: 'receipt' in first ? first.receipt : '' });
    expect(ignored).toEqual(replay);
    expect(logs.filter((message) => message.includes('ignored'))).toHaveLength(2);
    const designation = (
      await accessPool.query<{ receipt: string; account_subject: string; action: string }>(`
      SELECT e.receipt,p.account_subject,g.action
      FROM access.platform_grant_episode e
      JOIN access.principal_permission_grant g ON g.id = e.principal_grant_id
      JOIN access.principal p ON p.id = g.principal_id
      WHERE g.action = 'platform:grant' AND g.active AND g.valid_until = 'infinity'`)
    ).rows;
    expect(designation).toHaveLength(1);
    expect(designation[0]).toMatchObject({
      account_subject: account.operator.id,
      action: 'platform:grant',
    });
    expect(designation[0]!.receipt).toMatch(/^urn:rezics:access-receipt:[0-9a-f]{64}$/);

    const principalId = (
      await accessPool.query<{ id: string }>(
        `SELECT id FROM access.principal
         WHERE account_issuer = $1 AND account_subject = $2 AND active`,
        [account.issuer, account.operator.id],
      )
    ).rows[0]!.id;
    expect(
      await limits.classify(
        await verifier.verify(
          new Request('http://main.local', {
            headers: { authorization: `Bearer ${token}` },
          }),
          [],
        ),
      ),
    ).toBe('trusted');
    main = startMain();
    // Source intake stays behind the catalogue-import gate. Open that group
    // through the grant API for this principal; the gate still enforces it.
    const catalogueImport = await grantPlatformUse(
      { mainOrigin: origin, token, actingSubject: agent.agent, principalId },
      principalId,
      'catalogue-import',
    );
    expect(catalogueImport.permission).toBe('platform:use:catalogue-import');
    const plan = YAML.parse(
      await readFile(join(root, 'tests/fixtures/launch/plan.yaml'), 'utf8'),
    ) as BootstrapPlan;
    plan.namespace = namespace;
    plan.operators = [{ accountSubject: account.operator.id, actingSubject: agent.agent }];
    // Dev/test intake retains TBD stewards; production continues to refuse them.
    await mkdir(folder, { recursive: true });
    const planFile = join(folder, 'plan.yaml');
    await writeFile(planFile, YAML.stringify(plan));
    const artifact = Bun.env.REZICS_QA_ARTIFACT_DIR!;
    let interrupt = true;
    proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const response = await fetch(`${origin}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          ...(request.method === 'GET' ? {} : { body: await request.arrayBuffer() }),
        });
        if (!response.ok) {
          const problem = (await response
            .clone()
            .json()
            .catch(() => null)) as { code?: string; detail?: string } | null;
          console.error(
            'Bootstrap API response',
            request.method,
            url.pathname,
            response.status,
            problem?.code,
            problem?.detail,
          );
        }
        if (interrupt && request.method === 'POST' && url.pathname === '/v1/works' && response.ok) {
          // The graph effect and owner receipt exist, but the client's response
          // never arrives. Kill Task and its Bun child as one process group.
          interrupt = false;
          process.kill(-child!.pid!, 'SIGKILL');
        }
        return response;
      },
    });
    const proxyOrigin = `http://127.0.0.1:${proxy.port}`;
    const command = async (mainOrigin: string, verify = false) => {
      child = spawn(
        'task',
        [
          'ops:bootstrap',
          '--',
          '--mode',
          'qa',
          '--plan',
          planFile,
          '--main',
          mainOrigin,
          '--account',
          account.base,
          ...(verify ? ['--verify'] : []),
        ],
        {
          cwd: root,
          env: {
            ...Bun.env,
            BOOTSTRAP_MAIN_TOKEN: token,
            BOOTSTRAP_ACCOUNT_COOKIE: account.operator.cookie,
          },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const output = async (stream: NodeJS.ReadableStream) => {
        let text = '';
        for await (const bytes of stream) text += String(bytes);
        return text;
      };
      const [code, stdout, stderr] = await Promise.all([
        new Promise<number | null>((resolveExit, reject) => {
          child!.once('exit', resolveExit);
          child!.once('error', reject);
        }),
        output(child.stdout!),
        output(child.stderr!),
      ]);
      return { code, stdout, stderr };
    };
    const interrupted = await command(proxyOrigin);
    expect(interrupted.code).not.toBe(0);
    expect(interrupt, interrupted.stderr).toBe(false);
    const pending = JSON.parse(
      await readFile(join(folder, 'journal.json'), 'utf8'),
    ) as JournalState;
    const pendingWork = pending.entries[`bootstrap:${namespace}:work:vndb:v18334`]!;
    expect(pendingWork).toBeDefined();
    expect(pendingWork.response).toBeUndefined();
    const originalBody = pendingWork.body;
    const firstRun = await command(proxyOrigin);
    expect(firstRun.code, firstRun.stderr).toBe(0);
    const firstReport = JSON.parse(firstRun.stdout) as {
      result: string;
      outcome: { status: string };
      counts: Record<string, number>;
    };
    expect(firstReport.result).toBe('verified');
    expect(firstReport.outcome.status).toBe('completed');
    expect(firstReport.counts).toEqual({ 'https://schema.org/VideoGame': 1 });
    const journalBefore = await readFile(join(folder, 'journal.json'), 'utf8');
    const secondRun = await command(proxyOrigin);
    expect(secondRun.code, secondRun.stderr).toBe(0);
    expect(secondRun.stdout).toBe(firstRun.stdout);
    expect(await readFile(join(folder, 'journal.json'), 'utf8')).toBe(journalBefore);
    const verified = await command(proxyOrigin, true);
    expect(verified.code, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout).result).toBe('verified');

    const saved = JSON.parse(await readFile(join(folder, 'result.json'), 'utf8')) as {
      result: BootstrapResult;
    };
    const confirmed = JSON.parse(journalBefore) as JournalState;
    expect(confirmed.entries[`bootstrap:${namespace}:work:vndb:v18334`]!.body).toEqual(
      originalBody,
    );
    expect(saved.result.zones).toHaveLength(3);
    expect(
      Object.keys(saved.result.zones.find((zone) => zone.id === 'franchise-wiki')!.collections),
    ).toEqual(['franchise', 'characters', 'places', 'events', 'chapters']);
    expect(
      (
        await accessPool.query(`SELECT count(*)::int AS n
      FROM access.principal_permission_grant g
      JOIN access.platform_grant_episode e ON e.principal_grant_id = g.id
      WHERE g.action = 'platform:grant' AND g.active AND g.valid_until = 'infinity'`)
      ).rows[0]!.n,
    ).toBe(1);
    expect((await account.pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0]!.n).toBe(1);
    expect(
      (
        await fuseki.query(`PREFIX rv: <${RV}> SELECT ?work WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?work a <https://schema.org/CreativeWork> } }`)
      ).results!.bindings,
    ).toHaveLength(1);
    expect(
      (
        await accessPool.query(`SELECT count(*)::int AS n FROM access.permission_grant
      WHERE action IN ('semantic.change','zone.edit','catalogue.verify')`)
      ).rows[0]!.n,
    ).toBe(0);
    expect(
      (
        await accessPool.query(
          'SELECT count(*)::int AS n FROM access.platform_administrator_admission',
        )
      ).rows[0]!.n,
    ).toBeGreaterThan(0);
    // The launch proof above has exactly one real operator. An additional
    // member below is a privacy adversary fixture, never bootstrap/demo data.
    const member = await account.signUp('private-library-member');
    await account.pool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [member.id]);
    const memberToken = (await account.issue(client.client_id, member, scopes)).access_token;
    const send = (bearer: string, method: string, path: string, body?: unknown) =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'idempotency-key': `${namespace}:privacy:${randomUUID()}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const memberAgentResponse = await send(memberToken, 'POST', '/v1/agents', {
      profile: 'agent-provision-v1',
      kind: 'person',
      displayName: 'Private library member',
    });
    expect(memberAgentResponse.status, await memberAgentResponse.clone().text()).toBe(201);
    const memberAgent = ((await memberAgentResponse.json()) as { agent: string }).agent;
    const shelf = `https://rezics.com/id/${randomUUID()}`;
    const shelfResponse = await send(memberToken, 'POST', '/v1/collections', {
      collection: shelf,
      name: 'Private shelf',
      language: 'en',
      disclosure: 'private',
      actingSubject: memberAgent,
    });
    expect(shelfResponse.status, await shelfResponse.clone().text()).toBe(201);
    const shelfReceipt = (await shelfResponse.json()) as { revision: string };
    const privateWorkResponse = await send(memberToken, 'POST', '/v1/works', {
      profile: 'metadata-only-v1',
      authoring: 'own-work',
      title: 'Private member work',
      language: 'en',
      semanticTypes: ['https://schema.org/Book'],
      actingSubject: memberAgent,
    });
    expect(privateWorkResponse.status, await privateWorkResponse.clone().text()).toBe(201);
    const privateWork = ((await privateWorkResponse.json()) as { work: string }).work;
    const principal = await verifier.verify(
      new Request(origin, { headers: { authorization: `Bearer ${token}` } }),
      [],
    );
    const memberPrincipal = await verifier.verify(
      new Request(origin, { headers: { authorization: `Bearer ${memberToken}` } }),
      [],
    );
    expect(await access.canReadSemanticResource(memberPrincipal, memberAgent, shelf)).toBe(true);
    expect(await access.canReadWork(memberPrincipal, memberAgent, privateWork)).toBe(true);
    expect(await access.canReadSemanticResource(principal, agent.agent, shelf)).toBe(false);
    expect(await access.canReadWork(principal, agent.agent, privateWork)).toBe(false);
    expect(
      (
        await send(
          token,
          'GET',
          `/v1/collections/${shelf.slice(-36)}?actingSubject=${encodeURIComponent(agent.agent)}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await send(
          token,
          'GET',
          `/v1/works/${privateWork.slice(-36)}?actingSubject=${encodeURIComponent(agent.agent)}`,
        )
      ).status,
    ).toBe(404);
    for (const [action, scope] of [
      ['collection.edit', `collection:edit:${shelf}`],
      ['work.edit', `work:edit:${privateWork}`],
    ]) {
      await expect(
        access.register({
          principal,
          actingSubject: agent.agent,
          action: action!,
          scope: scope!,
          idempotencyKey: `${namespace}:denied:${action}`,
          requestDigest: 'a'.repeat(64),
        }),
      ).rejects.toThrow();
    }
    await expect(
      readExportPlan(
        {
          env,
          canReadWork: (person, actor, work) => access.canReadWork(person, actor, work),
          canReadSemantic: (person, actor, resource, revision) =>
            access.canReadSemanticResource(person, actor, resource, revision),
        },
        principal,
        agent.agent,
        {
          kind: 'semantic-revision',
          resource: shelf,
          reference: shelfReceipt.revision,
          expectedPosition: { dataEpoch: qa.dataEpoch, sequence: '0' },
        },
        'full',
      ),
    ).rejects.toBeInstanceOf(ExportSourceNotFound);
    await writeFile(
      join(artifact, 'g-724-bootstrap-proof.json'),
      JSON.stringify(
        {
          firstAdministrator: first,
          replay,
          ignored,
          interrupted: { code: interrupted.code },
          firstReport,
          result: saved.result,
          journal: JSON.parse(journalBefore) as JournalState,
        },
        null,
        2,
      ),
    );
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, 'SIGKILL');
      await new Promise((resolveExit) => child!.once('exit', resolveExit));
    }
    await proxy?.stop(true);
    await main?.stop(true);
    await account.stop();
    await Promise.all([accessPool.end(), contentPool.end()]);
    await rm(folder, { recursive: true, force: true });
  }
}, 600_000);
