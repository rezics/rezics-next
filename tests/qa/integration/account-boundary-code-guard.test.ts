import { expect, test } from 'bun:test';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { qaEnvironment, startAccount } from './account-boundary-fixture.ts';

test('IAM02: authorization-code exchanges above the Account pool size stay bounded and leave refused codes redeemable', async () => {
  const env = qaEnvironment();
  const databases = await cloneQaAccountAccessDatabases(env.runId);
  // Guards drawn from this three-connection owner pool would hold every
  // connection the exchanges need; the separate two-connection guard pool
  // bounds the wait instead.
  const account = await startAccount({ pool: { connectionString: databases.urls.account, max: 3 },
    secret: env.secret, resource: env.resource, codeGuardConnections: 2 });
  try {
    const app = await account.nativeApp('Burst App', 'openid work:create', true);
    const members = [];
    for (let index = 0; index < 12; index++) members.push(await account.signUp(`burst-${index}`));
    const pending = [];
    for (const member of members) {
      const code = await account.authorize(app.client_id, member, 'openid work:create', false);
      if (code instanceof Response) throw new Error(`authorize failed: ${code.status}`);
      pending.push(code);
    }
    const began = performance.now();
    const first = await Promise.all(pending.map(code => account.exchange(app.client_id, code)));
    expect(performance.now() - began).toBeLessThan(15_000);
    const statuses = first.map(response => response.status);
    expect(statuses.every(status => status === 200 || status === 503)).toBe(true);
    for (const response of first) {
      if (response.status === 503) {
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
      } else {
        expect((await response.json() as { access_token: string }).access_token).toBeTruthy();
      }
    }
    // A code refused while waiting for a guard was never consumed.
    const retried = await Promise.all(pending.map((code, index) => statuses[index] === 503
      ? account.exchange(app.client_id, code).then(response => response.status) : 200));
    expect(retried).toEqual(pending.map(() => 200));
    // Each code redeems once: every replay is rejected without new tokens.
    const tokenRows = async () => Number((await account.pool.query<{ count: string }>(
      'SELECT count(*) FROM "oauthAccessToken" WHERE "clientId" = $1', [app.client_id])).rows[0]!.count);
    const minted = await tokenRows();
    const replays = await Promise.all(pending.map(code => account.exchange(app.client_id, code)));
    expect(replays.map(response => response.status)).toEqual(pending.map(() => 400));
    expect(await tokenRows()).toBe(minted);
    expect((await fetch(`${account.local}/health/ready`)).status).toBe(200);
  } finally {
    await account.stop();
    await databases.close();
  }
}, 60_000);
