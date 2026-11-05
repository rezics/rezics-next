import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountWorkflows, HANDLE_CLAIM_PATTERN, type AccountWorkflowOptions } from '../src/workflows.ts';

test('Auth claim grammar agrees with the kernel source without a runtime dependency', async () => {
  const source = await Bun.file(new URL('../../kernel/src/access/handle-policy.ts', import.meta.url)).text();
  expect(source.match(/export const HANDLE_CLAIM_PATTERN = \/(.+)\//)?.[1]).toBe(HANDLE_CLAIM_PATTERN.source);
});

test('signup refuses invalid claims before staging, Turnstile or Access', async () => {
  let effects = 0;
  const database = new Pool({ connectionString: 'postgres://localhost/auth' });
  database.query = (() => {
    effects++;
    throw new Error('Unexpected staging call');
  }) as typeof database.query;
  const workflows = createAccountWorkflows({
    database,
    systemDatabaseUrl: 'postgres://localhost/auth_system',
    stagingKey: new Uint8Array(32).fill(7),
    auth: { verifier: { issuer: 'https://auth.test' } } as AccountWorkflowOptions['auth'],
    access: new Proxy(
      {},
      {
        get() {
          effects++;
          throw new Error('Unexpected Access call');
        },
      },
    ) as AccountWorkflowOptions['access'],
    turnstile: {
      secret: 'test',
      fetch: (async () => {
        effects++;
        throw new Error('Unexpected Siteverify call');
      }) as unknown as typeof fetch,
    },
  });
  try {
    for (const handle of [
      'a',
      'ab',
      'abc_',
      'abc-',
      '_abc',
      '-abc',
      ' abc',
      'abc ',
      'abc\n',
      'a b',
      'a'.repeat(65),
      'éaa',
    ]) {
      const response = await workflows.handler(
        new Request('https://auth.test/signup', {
          method: 'POST',
          headers: { origin: 'https://auth.test', 'content-type': 'application/json' },
          body: JSON.stringify({
            key: 'signup',
            handle,
            email: 'test@example.test',
            password: 'test-password',
            turnstile_token: 'token',
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'registration_denied' });
    }
    expect(effects).toBe(0);
  } finally {
    await database.end();
  }
});
