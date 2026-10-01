import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { libraryImportsRoutes } from '../src/routes/library-imports.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { principalClasses, rateLimitBudgets, rateLimitFamily } from '../src/modules/rate-limit/budgets.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

test('G931-M1: only file intake consumes uploads; import review and apply retain their write policy', () => {
  expect(rateLimitFamily('POST', '/v1/me/library-imports')).toBe('upload');
  for (const [method, path] of [
    ['GET', '/v1/me/library-imports/1/rows'], ['PUT', '/v1/me/library-imports/1/rows/0'],
    ['POST', '/v1/me/library-imports/1/apply'], ['POST', '/v1/me/library-imports/1/rows/0/adoptions'],
    ['DELETE', '/v1/me/library-imports/1'], ['POST', '/v1/me/library-import/batches'],
  ]) expect(rateLimitFamily(method!, path!)).toBe('write');
});

for (const principalClass of principalClasses.filter(name => name !== 'anonymous')) {
  test(`G931-M1: ${principalClass} uploads share principal capacity across bearers before parsing, inspection or retention`, async () => {
    const spent = new Map<string, number>();
    let retained = 0;
    const deps = {
      account: { verify: async () => ({ issuer: 'https://account.test', subject: 'same-reader' }) },
      access: { canReadAsBaselineMember: async () => true },
      libraryFiles: { create: async () => { retained++; return { id: '00000000-0000-4000-8000-000000000002', total: 1 }; } },
      libraryImport: {},
    } as unknown as MainWorkDependencies;
    const app = new Elysia().use(rateLimitHook(deps.account, {
      options: { secret: 'g931-budget-secret-at-least-32-characters', serviceClientIds: new Set(),
        trustedProxyPeers: new Set(), clientIpHeader: 'x-rezics-client-ip' },
      budgets: rateLimitBudgets(JSON.stringify({ [principalClass]: { upload: { maximum: 1, seconds: 86400 } } })),
      store: {
        classify: async () => principalClass,
        consume: async (identity, family, budget) => {
          expect(family).toBe('upload');
          const key = `${identity}:${family}`, count = spent.get(key) ?? 0;
          spent.set(key, count + 1);
          return { allowed: count < budget.maximum, retryAfter: 60 };
        },
      },
    })).use(libraryImportsRoutes(deps));
    const upload = (file: string, inspection = false, token = 'first-token') => app.handle(new Request('http://main.local/v1/me/library-imports', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({ actingSubject: agent, format: 'generic-csv', file,
        ...(!inspection ? { mapping: { title: 'Title', statuses: {} } } : {}) }),
    }));
    expect((await upload('Title\nFirst')).status).toBe(201);
    for (const [file, inspection] of [['Title\nSecond', false], ['Title\n"unterminated', false], ['Title\nPreview', true]] as const) {
      const refused = await upload(file, inspection, 'rotated-token');
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ family: 'upload' });
      expect(refused.headers.get('retry-after')).toBe('60');
    }
    expect(spent.size).toBe(1);
    expect(retained).toBe(1);
  });
}
