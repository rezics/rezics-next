import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { createQaStackPool } from '../../../scripts/qa/stack-pool.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { smtpSender } from '../../../services/account/src/email.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { ObjectNotFound, S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';

const root = resolve(import.meta.dir, '../../..');
const probe = Bun.env.REZICS_QA_POOL_PROBE;
interface PoolProbeEvidence {
  projectRunId: string;
  artifactDirectory: string;
  pid: number;
  holderPid: number;
  apps: Record<string, string>;
  compose: Record<string, string>;
  clean: { rows: number; objectAbsent: boolean; messages: number };
}

async function waitUntil<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(`Pool proof did not become ready within ${timeoutMs} ms`);
}

async function runPoolProbe(): Promise<void> {
  const directory = Bun.env.REZICS_QA_POOL_PROOF_DIRECTORY!;
  const marker = Bun.env.REZICS_QA_POOL_PROOF_MARKER!;
  const projectRunId = Bun.env.REZICS_QA_RUN_ID!;
  const stackDirectory = join(root, '.temp', 'stack', `rezics-qa-${projectRunId}`);
  const apps = readEnv(join(stackDirectory, 'apps.env'));
  const compose = readEnv(join(stackDirectory, 'compose.env'));
  const pool = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
  const email = `pool-${marker}@example.test`;
  const bytes = Buffer.from(`pooled immutable object ${marker}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const objects = new S3ImmutableObjects({ endpoint: apps.MAIN_S3_ENDPOINT!, bucket: apps.MAIN_S3_BUCKET!,
    region: apps.MAIN_S3_REGION!, accessKeyId: apps.MAIN_S3_ACCESS_KEY!, secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/work/' });
  const mailbox = `http://127.0.0.1:${compose.MAILPIT_HTTP_PORT}/api/v1/messages?limit=1`;
  try {
    const rows = (await pool.query('SELECT 1 FROM "user" WHERE email = $1', [email])).rowCount!;
    expect(rows).toBe(0);
    await objects.initialize();
    await expect(objects.probe(digest)).rejects.toBeInstanceOf(ObjectNotFound);
    const inboxResponse = await fetch(mailbox);
    expect(inboxResponse.ok).toBe(true);
    const inbox = await inboxResponse.json() as { total: number; messages: unknown[] };
    expect(inbox.total).toBe(0);
    expect(inbox.messages).toEqual([]);
    const account = createAccountApp(createAccountAuth({ baseURL: apps.ACCOUNT_BASE_URL!,
      secret: apps.ACCOUNT_SECRET!, resource: apps.ACCOUNT_MAIN_RESOURCE!, pool, operatorUserIds: new Set(),
    }), pool);
    const signup = await account.handle(new Request(`${apps.ACCOUNT_BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: apps.ACCOUNT_BASE_URL! },
      body: JSON.stringify({ ...signupPolicyFixture, name: 'Pool Proof', email, password: 'correct horse battery staple' }),
    }));
    expect(signup.status).toBe(200);
    expect((await pool.query('SELECT 1 FROM "user" WHERE email = $1', [email])).rowCount).toBe(1);
    expect(await objects.put(bytes)).toBe(digest);
    expect(Buffer.from(await objects.get(digest))).toEqual(bytes);
    await smtpSender({ host: '127.0.0.1', port: Number(compose.MAILPIT_SMTP_PORT), secure: false,
      requireTLS: false, user: '', password: '', from: 'REZICS QA <qa@example.test>',
    })({ id: randomUUID(), to: email, subject: 'Pool proof retained mail', text: marker, html: `<p>${marker}</p>` });
    const delivered = await fetch(mailbox);
    expect(delivered.ok).toBe(true);
    expect((await delivered.json() as { total: number }).total).toBe(1);
    const evidence: PoolProbeEvidence = { projectRunId, artifactDirectory: Bun.env.REZICS_QA_ARTIFACT_DIR!,
      pid: process.pid, holderPid: process.ppid, apps, compose,
      clean: { rows, objectAbsent: true, messages: inbox.total } };
    writeFileSync(join(directory, `${probe}.json`), JSON.stringify(evidence), { mode: 0o600 });
  } finally { await pool.end(); }
  if (probe === 'crash') while (true) await Bun.sleep(1000);
}

test('OPS01/IAM01: partial shared QA stack serves Main, Account and Fuseki', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through scripts/qa/cli.ts');
  if (probe) return await runPoolProbe();
  const pool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const account = createAccountApp(createAccountAuth({
    baseURL: Bun.env.ACCOUNT_BASE_URL!, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, pool, operatorUserIds: new Set(),
  }), pool);
  const main = createMainApp(new FusekiClient(Bun.env.FUSEKI_URL!));
  try {
    const [accountReady, discovery, mainReady, graph] = await Promise.all([
      account.handle(new Request(`${Bun.env.ACCOUNT_BASE_URL}/health/ready`)),
      account.handle(new Request(`${Bun.env.ACCOUNT_BASE_URL}/api/auth/.well-known/openid-configuration`)),
      main.handle(new Request('http://localhost/health/ready')),
      new FusekiClient(Bun.env.FUSEKI_URL!).query('ASK {}'),
    ]);
    expect(accountReady.status).toBe(200);
    expect(discovery.status).toBe(200);
    const metadata = await discovery.json() as { issuer: string; jwks_uri: string };
    expect(metadata.issuer).toBe(`${Bun.env.ACCOUNT_BASE_URL}/api/auth`);
    expect(metadata.jwks_uri).toBeTruthy();
    expect(mainReady.status).toBe(200);
    expect(graph.boolean).toBe(true);
    const signup = await account.handle(new Request(`${Bun.env.ACCOUNT_BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: Bun.env.ACCOUNT_BASE_URL! },
      body: JSON.stringify({ ...signupPolicyFixture, name: 'QA Smoke', email: `${Bun.env.REZICS_QA_RUN_ID}@example.test`,
        password: 'correct horse battery staple' }),
    }));
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    const session = await account.handle(new Request(`${Bun.env.ACCOUNT_BASE_URL}/api/auth/get-session`, {
      headers: { cookie: cookie! },
    }));
    expect(session.status).toBe(200);
    expect((await session.json() as { user?: { email?: string } }).user?.email)
      .toBe(`${Bun.env.REZICS_QA_RUN_ID}@example.test`);
  } finally { await pool.end(); }
}, probe ? 300_000 : 5000);

test.skipIf(Boolean(probe))('ordinary QA runs lease clean warm stacks and destroy a crashed holder stack', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through scripts/qa/cli.ts');
  const marker = randomUUID();
  const directory = join(root, '.temp', `qa-pool-proof-${marker}`);
  const slotDirectory = join(directory, 'slots');
  mkdirSync(slotDirectory, { recursive: true, mode: 0o700 });
  const switchFile = join(directory, 'qa-stack-pool');
  writeFileSync(switchFile, 'on\n');
  const environment = { ...process.env, GOAL_QA_SLOT_DIRECTORY: slotDirectory,
    GOAL_QA_WAIT_DIR: join(slotDirectory, 'waiters'), GOAL_QA_SLOTS: '1', GOAL_QA_HEAVY_RUN: '0',
    REZICS_QA_ARTIFACT_ROOT: join(directory, 'artifacts'), REZICS_QA_POOL_PROOF_DIRECTORY: directory,
    REZICS_QA_POOL_PROOF_MARKER: marker, REZICS_QA_STARTUP_SLOT_GATE: '',
    REZICS_QA_MEMORY_DEADLINE: String(Date.now() + 600_000) };
  const children: { process: ReturnType<typeof Bun.spawn>; output: Promise<string> }[] = [];
  const proofDeadline = Date.now() + 360_000;
  const logs = async (stream: ReadableStream<Uint8Array>) => {
    let tail = '';
    for await (const bytes of stream) tail = (tail + new TextDecoder().decode(bytes)).slice(-16_000);
    return tail;
  };
  const start = (step: string) => {
    const child = Bun.spawn(['bun', 'scripts/qa/cli.ts', '--tier', 'integration', '--file',
      'tests/qa/integration/shared-stack.test.ts'], { cwd: root,
      env: { ...environment, REZICS_QA_POOL_PROBE: step }, stdout: 'pipe', stderr: 'pipe' });
    const output = Promise.all([logs(child.stdout), logs(child.stderr)]).then(parts => {
      const text = parts.join('\n');
      writeFileSync(join(directory, `${step}.log`), text);
      return text;
    });
    const running = { process: child, output };
    children.push(running);
    return running;
  };
  const evidence = (step: string) => {
    const path = join(directory, `${step}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as PoolProbeEvidence : undefined;
  };
  const finish = async (step: string) => {
    const running = start(step);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([running.process.exited, new Promise<never>((_accept, reject) => {
      timer = setTimeout(() => reject(new Error(`Pool proof ${step} timed out; see ${directory}`)),
        Math.max(1, Math.min(180_000, proofDeadline - Date.now())));
    })]).finally(() => clearTimeout(timer));
    const output = await running.output;
    if (code !== 0) throw new Error(`Pool proof ${step} exited ${code}: ${output.slice(-6000)}`);
    const saved = evidence(step);
    expect(saved).toBeDefined();
    expect(saved!.clean).toEqual({ rows: 0, objectAbsent: true, messages: 0 });
    return saved!;
  };
  const killTest = (pid: number) => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* test group already exited */ }
  };
  try {
    const first = await finish('first');
    const second = await finish('second');
    expect(second.projectRunId).toBe(first.projectRunId);
    const summary = readFileSync(join(second.artifactDirectory, 'summary.md'), 'utf8');
    expect(summary).toMatch(new RegExp(`leased from rezics-qa-${first.projectRunId}, parked for \\d+ ms`));
    const crashed = start('crash');
    const ready = await waitUntil(() => {
      if (crashed.process.exitCode !== null) throw new Error(`Crash probe exited early (${crashed.process.exitCode})`);
      return evidence('crash');
    }, Math.max(1, Math.min(180_000, proofDeadline - Date.now())));
    expect(ready.projectRunId).toBe(first.projectRunId);
    expect(ready.holderPid).toBe(crashed.process.pid);
    // SIGKILL bypasses the holder's normal exit cleanup. Stop its detached Bun
    // test group too, so it cannot write after dead-holder destruction starts.
    crashed.process.kill('SIGKILL');
    killTest(ready.pid);
    await crashed.process.exited;
    await crashed.output;
    const replacement = await finish('replacement');
    expect(replacement.projectRunId).not.toBe(ready.projectRunId);
    expect(readFileSync(join(replacement.artifactDirectory, 'summary.md'), 'utf8')).not.toContain('leased from');
  } finally {
    for (const child of children) if (child.process.exitCode === null) child.process.kill('SIGKILL');
    const ready = evidence('crash');
    if (ready) killTest(ready.pid);
    await Promise.all(children.map(child => child.process.exited));
    writeFileSync(switchFile, 'off\n');
    await createQaStackPool({ root, slotDirectory, slots: 1, env: environment, janitor: false }).sweep();
  }
}, 600_000);
