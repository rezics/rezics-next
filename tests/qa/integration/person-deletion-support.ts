import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';
import { freePort } from './account-boundary-fixture.ts';

/** Run the production entrypoint so Account's deletion hook is part of the proof. */
export async function startPersonDeletionAccount() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const root = resolve(import.meta.dir, '../../..');
  const directory = resolve(root, '.temp', `person-deletion-account-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const log = resolve(directory, 'account.log');
  const pool = boundedPool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL! });
  const process = Bun.spawn(['bun', 'services/account/src/index.ts'], {
    cwd: root,
    env: { ...Bun.env, ACCOUNT_PORT: String(port), ACCOUNT_BASE_URL: base,
      ACCOUNT_ACCESS_DATABASE_URL: Bun.env.ACCESS_DATABASE_URL!, ACCOUNT_TURNSTILE_MODE: 'local',
      ACCOUNT_OPERATOR_USER_IDS: '' },
    stdout: Bun.file(log), stderr: Bun.file(log),
  });
  const close = async () => {
    process.kill('SIGTERM');
    try { await process.exited; }
    finally { await pool.end(); rmSync(directory, { recursive: true, force: true }); }
  };
  const post = (path: string, body: unknown, cookie?: string) => fetch(`${base}${path}`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  try {
    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline && process.exitCode === null) {
      try {
        const response = await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(2_000) });
        ready = response.ok;
        await response.body?.cancel();
        if (ready) break;
      } catch { /* The listener has not started yet. */ }
      await Bun.sleep(200);
    }
    if (!ready) throw new Error(`Production Account did not become ready: ${readFileSync(log, 'utf8').slice(-4000)}`);
    const password = 'correct horse battery staple';
    const email = `person-deletion-${randomUUID()}@example.test`;
    const signup = await post('/api/auth/sign-up/email', { ...signupPolicyFixture, email, password, name: 'Closing Account' });
    expect(signup.status, await signup.text()).toBe(200);
    // Enrollment is real; replace only mail delivery's verification for this fixture.
    const verified = await pool.query<{ id: string }>(
      'UPDATE "user" SET "emailVerified" = true WHERE email = $1 RETURNING id', [email]);
    expect(verified.rows).toHaveLength(1);
    const id = verified.rows[0]!.id;
    const signin = await post('/api/auth/sign-in/email', { email, password });
    expect(signin.status, await signin.text()).toBe(200);
    const cookie = signin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect(cookie).not.toBe('');
    const principal = { issuer: `${base}/api/auth`, subject: id, emailVerified: true };
    return { principal, close, deleteWithConsent: async () => {
      const stepUp = await post('/api/account/reauthenticate', { password }, cookie);
      expect(stepUp.status, await stepUp.text()).toBe(200);
      // The same operation the Accounts app invokes, with explicit owned-Agent consent.
      const response = await post('/api/auth/delete-user', { password, leaveOwnedAgentsStanding: true }, cookie);
      expect(response.status, await response.text()).toBe(200);
      expect((await pool.query('SELECT id FROM "user" WHERE id = $1', [id])).rows).toEqual([]);
    } };
  } catch (error) { await close(); throw error; }
}
