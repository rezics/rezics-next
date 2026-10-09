import { createServer } from 'node:net';
import { getMigrations } from 'better-auth/db/migration';
import { Pool, type PoolConfig } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { accountAuthOptions, createAccountAuth, type AccountConfig } from '../src/auth.ts';
import { createAccountApp } from '../src/app.ts';
import { installConsentRefreshFence } from '../src/consent-fence.ts';
import { accountEmailQueue } from '../src/email.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
export { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';

export async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

export async function accountFixture(overrides: Partial<AccountConfig> = {}, hostname = '127.0.0.1',
  poolOptions: Pick<PoolConfig, 'max' | 'connectionTimeoutMillis'> = {}) {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, ...poolOptions });
  const accountPort = await freePort();
  const baseURL = `http://${hostname}:${accountPort}`;
  const secret = 'account-g205-integration-secret-at-least-32';
  const messages: { id: string; to: string; text: string; html: string; subject: string }[] = [];
  const email = accountEmailQueue(pool, secret, async mail => { messages.push(mail); }, baseURL);
  const operators = new Set<string>();
  const displayPreferenceClientIds = new Set<string>();
  const config = { baseURL, secret, resource: 'https://main.rezics.test', pool,
    operatorUserIds: operators, email, ...overrides };
  let app: ReturnType<typeof createAccountApp> | undefined;
  const close = async () => {
    try {
      await app?.stop();
      await pool.end();
    } finally { cluster.remove(); }
  };
  try {
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    await installConsentRefreshFence(pool);
    const auth = createAccountAuth(config);
    app = createAccountApp(auth, pool, { operatorUserIds: operators, displayPreferenceClientIds })
      .listen({ hostname: '127.0.0.1', port: accountPort });
    const request = (path: string, body?: unknown, cookie?: string, extra: HeadersInit = {}) =>
      fetch(new URL(path, baseURL), { method: body === undefined ? 'GET' : 'POST',
        redirect: 'manual', headers: { origin: baseURL, 'content-type': 'application/json',
          ...(cookie ? { cookie } : {}), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(new URL(path, baseURL).pathname === '/api/auth/sign-up/email'
          ? { ...signupPolicyFixture,
            ...body as Record<string, unknown> } : body) }) });
    const signup = async (address: string) => {
      const password = 'correct horse battery staple';
      const response = await request('/api/auth/sign-up/email', { email: address, name: 'Account Test', password });
      if (!response.ok) throw new Error(`Sign up: ${response.status} ${await response.text()}`);
      await email.drain();
      const mail = [...messages].reverse().find(message => message.to === address)!;
      const url = /https?:\/\/\S+/.exec(mail.text)![0];
      const verified = await request(url);
      if (verified.status !== 302 && !verified.ok) throw new Error(`Verify: ${await verified.text()}`);
      const signed = await request('/api/auth/sign-in/email', { email: address, password });
      if (!signed.ok) throw new Error(`Sign in: ${await signed.text()}`);
      const cookie = signed.headers.get('set-cookie')!;
      const { user } = await signed.json() as { user: { id: string } };
      return { cookie, id: user.id, email: address, password };
    };
    return { pool, baseURL, secret, config, auth, operators, displayPreferenceClientIds,
      messages, email, request, signup, close };
  } catch (error) { await close(); throw error; }
}
