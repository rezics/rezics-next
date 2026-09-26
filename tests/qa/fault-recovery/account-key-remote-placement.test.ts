import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Client, Pool } from 'pg';
import { hostLoopbackAccess, loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { freePort, mainWithAccount, qaEnvironment, representAgents, startAccount }
  from '../integration/account-boundary-fixture.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

// The adopted QA fault proxy (docs/development/toolchain.md).
const TOXIPROXY = 'ghcr.io/shopify/toxiproxy:2.12.0@sha256:9378ed52a28bc50edc1350f936f518f31fa95f0d15917d6eb40b8e376d1a214e';
const TIMEOUT_MS = 1_500;

test('OPS08: remote Account placement isolates network partition, Account database loss and refused Main credentials, with no private database shortcut', async () => {
  const env = qaEnvironment();
  const docker = loadDockerEnvironment();
  const loopback = hostLoopbackAccess(docker);
  if (loopback.host !== 'host.docker.internal') {
    throw new Error('The OPS08 partition fixture needs Docker Desktop host-gateway networking');
  }
  const run = (...args: string[]) => {
    const result = spawnSync('docker', args, { env: docker, encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const suffix = randomBytes(4).toString('hex');
  const hops = { edge: `rezics-ops08-edge-${suffix}`, db: `rezics-ops08-db-${suffix}` };
  const databases = await cloneQaAccountAccessDatabases(env.runId);
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const started: string[] = [];
  let account: Awaited<ReturnType<typeof startAccount>> | undefined;
  try {
    // Two network hops, each a proxy container on its own Docker network: the
    // public edge Main uses to reach Account, and Account's own database link.
    for (const hop of Object.values(hops)) {
      run('network', 'create', hop);
      started.push(hop);
      run('run', '-d', '--rm', '--name', hop, '--network', hop, ...loopback.args,
        '-p', '127.0.0.1::8474', '-p', '127.0.0.1::20000', TOXIPROXY, '-host', '0.0.0.0');
    }
    const published = (hop: string, port: number) =>
      Number(run('port', hop, `${port}/tcp`).split('\n')[0]!.split(':').pop());
    const api = (hop: string) => `http://127.0.0.1:${published(hop, 8474)}`;
    const accountPort = await freePort();
    const database = new URL(databases.urls.account);
    for (const [hop, upstream] of [[hops.edge, accountPort], [hops.db, Number(database.port)]] as const) {
      const deadline = Date.now() + 20_000;
      while (!(await fetch(`${api(hop)}/version`).then(response => response.ok, () => false))) {
        if (Date.now() > deadline) throw new Error(`${hop} proxy did not start`);
        await Bun.sleep(100);
      }
      const created = await fetch(`${api(hop)}/proxies`, { method: 'POST', body: JSON.stringify({
        name: 'link', listen: '0.0.0.0:20000', upstream: `${loopback.host}:${upstream}` }) });
      expect(created.status).toBe(201);
    }
    const edgeOrigin = `http://127.0.0.1:${published(hops.edge, 20000)}`;
    account = await startAccount({ secret: env.secret, resource: env.resource, port: accountPort,
      publicOrigin: edgeOrigin, pool: { host: '127.0.0.1', port: published(hops.db, 20000),
        user: decodeURIComponent(database.username), password: decodeURIComponent(database.password),
        database: database.pathname.slice(1), max: 8, connectionTimeoutMillis: 5_000 } });
    const owner = account;
    const scope = 'openid work:create offline_access';
    const verifierClient = await owner.workloadApp('Remote Main verifier', ['work:create']);
    const product = await owner.nativeApp('Remote product', scope, true);
    const member = await owner.signUp('member');
    const { agents: [agent] } = await representAgents(accessPool, owner.issuer, member.id, 1);
    // Main knows Account only by its public issuer origin and a client credential.
    const mainConfig = { ...owner.verifierConfig(verifierClient), timeoutMs: TIMEOUT_MS };
    expect(new URL(mainConfig.introspectUrl).origin).toBe(edgeOrigin);
    let { main, discover, check } = mainWithAccount(env, accessPool,
      new AccountAssertionVerifier(mainConfig));
    const tokens = await owner.issue(product.client_id, member, scope, false);
    const epoch = (await discover(tokens.access_token)).body.authorityEpoch;
    const protectedCall = async () => {
      const began = performance.now();
      const result = await check(tokens.access_token, agent!, epoch);
      return { ...result, elapsed: performance.now() - began };
    };
    const publicCalls = async () => Promise.all(['/health/live', '/health/ready'].map(async path =>
      (await main.handle(new Request(`http://main.local${path}`))).status));
    const gate = async () => (await accessPool.query<{ authority_epoch: string }>(
      "SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root'")).rows[0]!.authority_epoch;
    const accountReady = async () => {
      const began = performance.now();
      const response = await fetch(`${owner.local}/health/ready`);
      return { status: response.status, elapsed: performance.now() - began };
    };
    expect((await protectedCall()).status).toBe(200);
    expect(await publicCalls()).toEqual([200, 200]);

    // No private shortcut: Main's own owner credentials cannot read Account rows.
    for (const url of [env.accessDatabaseUrl, Bun.env.CONTENT_DATABASE_URL!, Bun.env.ACCOUNT_RELAY_DATABASE_URL!]) {
      const role = new URL(url);
      const probe = new Client({ host: role.hostname, port: Number(role.port),
        user: decodeURIComponent(role.username), password: decodeURIComponent(role.password),
        database: database.pathname.slice(1) });
      let refused: unknown;
      try {
        await probe.connect();
        await probe.query('SELECT count(*) FROM public.session');
      } catch (error) { refused = error; }
      finally { await probe.end().catch(() => undefined); }
      expect((refused as { code?: string } | undefined)?.code, role.username).toBe('42501');
    }

    // Partition Main from Account. Account and its database stay healthy, so a
    // protected admission could only succeed through a shortcut; it fails
    // closed within the verifier bound instead, and public Main keeps serving.
    const epochBefore = await gate();
    run('network', 'disconnect', hops.edge, hops.edge);
    expect((await accountReady()).status).toBe(200);
    expect((await owner.pool.query('SELECT 1 AS up')).rows).toEqual([{ up: 1 }]);
    const partitioned = await Promise.all(Array.from({ length: 6 }, protectedCall));
    for (const outcome of partitioned) {
      expect(outcome.status).toBe(503);
      expect(outcome.body.code).toBe('dependency_unavailable');
      expect(outcome.elapsed).toBeLessThan(2 * TIMEOUT_MS + 1_000);
    }
    const publicBegan = performance.now();
    expect(await publicCalls()).toEqual([200, 200]);
    expect(performance.now() - publicBegan).toBeLessThan(1_000);
    expect(await gate()).toBe(epochBefore);

    // Heal: the same Main process admits again without a restart.
    run('network', 'connect', hops.edge, hops.edge);
    const healDeadline = Date.now() + 15_000;
    let healed = await protectedCall();
    while (healed.status !== 200 && Date.now() < healDeadline) {
      await Bun.sleep(250);
      healed = await protectedCall();
    }
    expect(healed.status).toBe(200);

    // Account loses its own database link: Account reports unavailable within
    // its bound, Main fails closed, and both recover when the link returns.
    const link = `${api(hops.db)}/proxies/link`;
    expect((await fetch(link, { method: 'POST', body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    const unready = await accountReady();
    expect(unready.status).toBe(503);
    expect(unready.elapsed).toBeLessThan(3_000);
    const orphaned = await protectedCall();
    expect(orphaned.status).toBe(503);
    expect(orphaned.body.code).toBe('dependency_unavailable');
    expect(orphaned.elapsed).toBeLessThan(2 * TIMEOUT_MS + 1_000);
    expect(await publicCalls()).toEqual([200, 200]);
    expect((await fetch(link, { method: 'POST', body: JSON.stringify({ enabled: true }) })).status).toBe(200);
    const relinkDeadline = Date.now() + 15_000;
    let relinked = await protectedCall();
    while (relinked.status !== 200 && Date.now() < relinkDeadline) {
      await Bun.sleep(250);
      relinked = await protectedCall();
    }
    expect(relinked.status).toBe(200);
    expect((await accountReady()).status).toBe(200);

    // Account refuses Main's rotated-out credential. The token's state is then
    // unknown to Main: unavailable, never an allow or a token denial, and the
    // user's Account authority is untouched until Main uses the new credential.
    const rotated = await owner.auth.api.rotateClientSecret({ headers: owner.adminHeaders,
      body: { client_id: verifierClient.client_id } }) as { client_secret: string };
    expect(rotated.client_secret).not.toBe(verifierClient.client_secret);
    for (let attempt = 0; attempt < 3; attempt++) {
      const refused = await protectedCall();
      expect(refused.status).toBe(503);
      expect(refused.body.code).toBe('dependency_unavailable');
    }
    expect(await owner.introspect({ client_id: verifierClient.client_id,
      client_secret: rotated.client_secret }, tokens.access_token)).toMatchObject({ active: true });
    expect((await owner.refresh(product.client_id, tokens.refresh_token!)).status).toBe(200);
    ({ main, discover, check } = mainWithAccount(env, accessPool, new AccountAssertionVerifier({
      ...mainConfig, clientSecret: rotated.client_secret })));
    expect((await protectedCall()).status).toBe(200);
    expect(await gate()).toBe(epochBefore);
  } finally {
    await account?.stop();
    await accessPool.end();
    await databases.close();
    for (const name of started.reverse()) {
      spawnSync('docker', ['rm', '-f', name], { env: docker, timeout: 30_000 });
      spawnSync('docker', ['network', 'rm', name], { env: docker, timeout: 30_000 });
    }
  }
}, 120_000);
