import { expect, test } from 'bun:test';
import { createKernel } from '../../src/http/kernel.ts';
import { createNativeContentSystem } from '../content/support/native-system.ts';

test('createKernel resolves Access only when a request first needs it', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const system = await createNativeContentSystem({ databaseUrl });
  try {
    let returned = false;
    let resolutions = 0;
    const kernel = createKernel({
      pool: system.database.pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      access: () => {
        if (!returned) throw new Error('Access resolved before createKernel returned');
        resolutions++;
        return access;
      },
    });
    returned = true;
    const access = system.access;
    expect(resolutions).toBe(0);

    const health = await kernel.handle(new Request('http://localhost/health'));
    expect(health.status).toBe(200);
    expect(resolutions).toBe(0);

    const author = system.actors.author;
    for (let request = 0; request < 2; request++) {
      const response = await kernel.handle(
        new Request(`http://localhost/v1/accounts/${author.actor.accountId}/notifications`, {
          headers: { authorization: `Bearer ${author.bearer}` },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [], next: null });
      expect(resolutions).toBe(1);
    }
  } finally {
    await system.close();
  }
});
