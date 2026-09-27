import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { readEnv } from '../../../scripts/dev/config.ts';
import { people, realms, works } from '../../../scripts/dev/seed/plan.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { accountEmailQueue, smtpSender } from '../../../services/account/src/email.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';

test('baseline demo seed: verified signups, Works, contributions, Spaces and personal shelves use public APIs without grants', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID!);
  const oldAccount = Bun.env.ACCOUNT_DATABASE_URL;
  const oldAccess = Bun.env.ACCESS_DATABASE_URL;
  Bun.env.ACCOUNT_DATABASE_URL = databases.urls.account;
  Bun.env.ACCESS_DATABASE_URL = databases.urls.access;
  const scopes = ['agent:create', 'work:create', 'work:edit', 'work:read',
    'space:create', 'collection:edit', 'semantic:read'];
  let h: Awaited<ReturnType<typeof agentProvisionHarness>>;
  try { h = await agentProvisionHarness(scopes); }
  catch (error) { await databases.close(); throw error; }
  finally { Bun.env.ACCOUNT_DATABASE_URL = oldAccount; Bun.env.ACCESS_DATABASE_URL = oldAccess; }
  const directory = join(root, '.temp', `baseline-seed-${randomUUID()}`);
  mkdirSync(join(directory, 'web-auth'), { recursive: true });
  const compose = readEnv(join(root, '.temp', 'stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`, 'compose.env'));
  const email = accountEmailQueue(h.accountPool, Bun.env.ACCOUNT_SECRET!, smtpSender({
    host: '127.0.0.1', port: Number(compose.MAILPIT_SMTP_PORT), secure: false,
    requireTLS: false, user: '', password: '', from: 'REZICS QA <qa@example.test>' }));
  let delivering: Promise<void> | undefined;
  const timer = setInterval(() => {
    delivering ??= email.drain().finally(() => { delivering = undefined; });
  }, 50);
  let accountApp: ReturnType<typeof createAccountApp>;
  const accountServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => accountApp.handle(request) });
  const accountBase = `http://127.0.0.1:${accountServer.port}`;
  accountApp = createAccountApp(createAccountAuth({ baseURL: accountBase, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, pool: h.accountPool, operatorUserIds: new Set(),
    email, requireEmailVerification: true }), h.accountPool);
  const account = new AccountAssertionVerifier({ issuer: `${accountBase}/api/auth`,
    audience: Bun.env.ACCOUNT_MAIN_RESOURCE!, jwksUrl: `${accountBase}/api/auth/jwks`,
    introspectUrl: `${accountBase}/api/auth/oauth2/introspect`,
    clientId: h.verifierClient.client_id, clientSecret: h.verifierClient.client_secret! });
  const access = new AccessAdmissionRegistry(h.accessPool);
  access.configureBaseline(h.fuseki);
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  const app = createMainApp(h.fuseki, { environment: h.env, account, access,
    agentHandles: new AgentVanityHandles(h.accessPool),
    agentProvisioning: new AgentProvisioning(h.accessPool, h.env), structureObjects: objects });
  const main = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.handle(request) });
  writeFileSync(join(directory, 'dev.env'), `ACCOUNT_BASE_URL=${accountBase}\nMAIN_ORIGIN=http://127.0.0.1:${main.port}\nMAILPIT_HTTP_PORT=${compose.MAILPIT_HTTP_PORT}\n`);
  writeFileSync(join(directory, 'web-auth/public.json'), JSON.stringify({ clientId: h.client.client_id,
    redirectUris: [h.redirectUri], resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, scope: `openid ${scopes.join(' ')}` }));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = Bun.spawn(['bun', 'scripts/dev/seed/cli.ts'], { cwd: root,
        env: { ...process.env, REZICS_SEED_STACK_DIRECTORY: directory }, stdout: 'pipe', stderr: 'pipe' });
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      writeFileSync(join(directory, `attempt-${attempt}.log`), output + error, { mode: 0o600 });
      // This deliberately small owner fixture reports optional API gaps;
      // provisioning and the author's baseline operations must still finish.
      expect(code, error).toBe(2);
      expect(error).toBe('');
      const summary = `Seeded ${works.length} Works, ${realms.length} Realms, ${people.length} Account users, 9 Agents, 8 published contributions,`;
      if (!output.includes(summary)) console.log(output.split('\n').filter(line =>
        /Seeded|HTTP|API gaps/.test(line)).join('\n'));
      expect(output).toContain(summary);
      expect(output).not.toMatch(/(?:Space \/ Realm creation|Personal collection|Text contribution|Translation link|Contribution publication).*HTTP/);
      console.log(`Demo seed attempt ${attempt + 1}: ${summary}`);
    }
    expect((await h.accessPool.query('SELECT count(*)::text AS n FROM access.permission_grant')).rows[0]?.n).toBe('0');
    expect((await h.accountPool.query('SELECT count(*)::text AS n FROM "user" WHERE "emailVerified"')).rows[0]?.n).toBe(String(people.length));
    // Keep the exact API gaps as QA evidence, without fixture credentials.
    const output = readFileSync(join(directory, 'attempt-1.log'), 'utf8');
    const gaps = output.slice(output.indexOf('Public API gaps or unavailable outcomes:'));
    const evidence = join(root, '.temp', 'goal');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'baseline-seed-evidence.json'), JSON.stringify({
      qaRunId: Bun.env.REZICS_QA_RUN_ID, attempts: 2, works: works.length, spaces: realms.length,
      verifiedAccounts: people.length, agents: 9, publishedContributions: 8, explicitGrants: 0, gaps,
    }, null, 2));
    console.log(gaps);
  } finally {
    clearInterval(timer);
    await delivering;
    await main.stop(true);
    await accountServer.stop(true);
    await h.close();
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);
