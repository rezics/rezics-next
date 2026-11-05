import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { planReads, platformRegistry, resolveTemplate } from '@rezics/composition';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { platformProfile } from '../../src/presentation/setup.ts';
import { createRealAccess } from './real-access.ts';

const pool = createPool(process.env.DATABASE_URL!);
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const access = await createRealAccess(admin, { member: '019a1b2c-3d4e-7f00-8a00-ed170e000019' }, []);
const kernel = createKernel({
  pool,
  routeKey: new Uint8Array(32).fill(19),
  requestDeadlineMs: 30_000,
  access: access.access,
  writeRate: access.writeRate,
});
beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await bootstrapProfile(pool, platformProfile);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

// This mounted regression pins admission. Seeded-stack membership and served-page acceptance remain separate.
test('anonymous and member Home TypeLists use the active release and preserve standalone native outcomes', async () => {
  const expected = resolveTemplate(platformProfile, { route: '/' });
  const plan = planReads(platformRegistry, expected.document, { subject: null });
  for (const member of [false, true]) {
    const headers = {
      'content-type': 'application/json',
      ...(member ? { authorization: `Bearer ${access.bearer('member')}` } : {}),
    };
    const response = await kernel.handle(
      new Request('http://kernel.test/v1/pages:read', {
        method: 'POST',
        headers,
        body: JSON.stringify({ target: { route: '/' } }),
      }),
    );
    const page = await response.json();
    expect(response.status, JSON.stringify(page)).toBe(200);
    expect(page.document).toEqual(expected.document);
    expect(Object.keys(page.reads)).toHaveLength(4);
    for (const [key, descriptor] of Object.entries(plan.reads)) {
      if (descriptor.kind !== 'search') throw new Error('Home must plan native Search reads');
      const standalone = await kernel.handle(
        new Request('http://kernel.test/v1/subjects:search', {
          method: 'POST',
          headers,
          body: JSON.stringify(descriptor.body),
        }),
      );
      expect(page.reads[key].status).toBe(standalone.status);
      // Request identifiers and freshness timestamps belong to independent observations.
      expect(page.reads[key].status).not.toBe(400);
      expect(page.reads[key].status).not.toBe(422);
    }
  }
});
