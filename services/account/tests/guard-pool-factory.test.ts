import { expect, test } from 'bun:test';
import { Client, Pool, type PoolConfig } from 'pg';
import { createAccountApp } from '../src/app.ts';
import { boundedPool, observeSqlPool, type SqlPoolObservation, type SqlWorkEvent } from '../../main/src/infrastructure/pg-pool.ts';

test('injected Account guard preserves options and observes its first checkout before authority work', async () => {
  const owner = new Pool({ user: 'owner', password: 'private-test-password', max: 9, application_name: 'owner-test' });
  const events: SqlWorkEvent[] = [], observations: SqlPoolObservation[] = [];
  let guard: Pool | undefined, supplied: PoolConfig | undefined, constructions = 0, providerCalls = 0;
  class UnavailableClient extends Client { constructor() { super(); throw new Error('controlled external connection failure'); } }
  const auth = { options: { baseURL: 'https://account.example.test', secret: 'private-test-secret' },
    handler: async () => { providerCalls++; return Response.json({ ok: true }); } } as unknown as Parameters<typeof createAccountApp>[0];
  const app = createAccountApp(auth, owner, { codeGuardConnections: 3,
    createGuardPool(config) {
      constructions++; supplied = config;
      guard = boundedPool({ ...config, Client: UnavailableClient });
      observations.push(observeSqlPool(guard, event => { events.push(event); }));
      expect(events[0]).toMatchObject({ kind: 'snapshot', complete: true, totals: { starts: 0 } });
      return guard;
    } });
  expect(constructions).toBe(0);
  const request = () => new Request('https://account.example.test/api/auth/oauth2/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=controlled-code' });
  try {
    for (let index = 0; index < 2; index++) expect((await app.handle(request())).status).toBe(503);
    expect(constructions).toBe(1); expect(providerCalls).toBe(0);
    expect(supplied).toMatchObject({ user: 'owner', password: 'private-test-password', application_name: 'owner-test',
      max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
    expect(events.at(-1)).toMatchObject({ complete: true, totals: { starts: 2, released: 2, active: 0, pending: 0 } });
  } finally {
    await guard?.end(); await owner.end();
    for (const observation of observations) observation.detach();
    await Promise.all(observations.map(observation => observation.drain()));
  }
});
