import { afterAll, expect, spyOn, test } from 'bun:test';
import { t } from 'elysia';
import { createApp } from '../../src/http/app.ts';
import { customMethod } from '../../src/http/custom-method.ts';
import { actionCatalogue, MountedRouteCatalogue } from '../../src/http/request.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const secret = 'mounted-route-growth-secret-at-least-32-bytes';

test('mounted declarations and one native counter statement stay bounded as routes and background rows grow', async () => {
  const lookup = spyOn(MountedRouteCatalogue.prototype, 'find');
  try {
    for (const units of [1, 100] as const) {
      await db.admin.query('TRUNCATE access.write_rate_counter');
      const real = createWriteRateLimiter({
        secret,
        overrides: '{"anonymous":{"write":{"maximum":100000,"seconds":86400}}}',
      });
      let app: ReturnType<typeof createApp>;
      let spends = 0,
        routeReads = 0,
        detailReads = 0;
      let constructionReads = 0;
      let actions: ReturnType<typeof actionCatalogue>;
      const report = await checkGrowth(db, {
        name: `mounted-write-rate-${units}`,
        scales: [1, 4, 16],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(_database, scale, previous) {
          await db.admin.query(
            `INSERT INTO access.write_rate_counter(route,identity_digest,family,count,expires_at)
            SELECT 0, md5(i::text) || md5(i::text), family, 0, now() + interval '1 day'
            FROM generate_series($1::integer,$2::integer) i CROSS JOIN (VALUES ('write'),('unrelated')) f(family)`,
            [previous * 128 + 1, scale * 128],
          );
          await db.admin.query('ANALYZE access.write_rate_counter');
          app = createApp({
            pool: db.pool,
            ratePeer: () => '192.0.2.1',
            writeRate: {
              async spend(context, family, chargedUnits) {
                spends++;
                expect([family, chargedUnits]).toEqual(['write', units]);
                return real.spend(context, family, chargedUnits);
              },
            },
          });
          const backgroundDetail = {
            operationId: 'item.create',
            security: [{}],
            'x-action': 'item:create',
            'x-exposure': 'public',
            'x-rate-limit': defineRateLimit({ family: 'report', units: 1 }),
          };
          for (let index = 0; index < 8 * scale; index++)
            app.post(
              `/unrelated/${index}`,
              {
                detail: backgroundDetail,
              },
              () => true,
            );
          app.post(
            customMethod('/items/:id', 'update'),
            {
              body: t.Object({ commands: t.Array(t.Object({ value: t.Integer() }), { minItems: 1, maxItems: 100 }) }),
              detail: {
                operationId: 'item.update',
                security: [{}],
                'x-action': 'item:update',
                'x-exposure': 'public',
                'x-rate-limit': defineRateLimit({ family: 'write', units: units === 1 ? 1 : 'commands' }),
              },
            },
            () => true,
          );
          routeReads = detailReads = 0;
          const routes = app.routes.map((route) => ({
            ...route,
            hooks: {
              get detail() {
                detailReads++;
                return route.hooks?.detail;
              },
            },
          }));
          Object.defineProperty(app, 'routes', {
            get() {
              routeReads++;
              return routes;
            },
          });
          app.compile();
          expect(routeReads).toBe(1);
          expect(detailReads).toBeLessThanOrEqual(2 * routes.length);
          constructionReads = detailReads;
          actions = actionCatalogue(app);
        },
        async operation() {
          const beforeLookups = lookup.mock.calls.length,
            beforeSpends = spends;
          const response = await app.handle(
            new Request('http://localhost/items/fixed:update', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ commands: Array.from({ length: units }, () => ({ value: 1 })) }),
            }),
          );
          expect(response.status).toBe(200);
          expect(actionCatalogue(app)).toBe(actions);
          expect(await response.json()).toBe(true);
          expect(lookup.mock.calls.length - beforeLookups).toBe(1);
          expect(spends - beforeSpends).toBe(1);
          expect(routeReads).toBe(1);
          expect(detailReads).toBe(constructionReads);
        },
      });
      for (const { cost } of report.samples) {
        expect(cost.statements).toBe(1);
        expect(cost.rows).toBe(0);
        expect(cost.relations?.['access.write_rate_counter']?.rows).toBe(1);
        expect(cost.blocks).toBeGreaterThan(0);
      }
      expect(spends).toBe(18);
      expect((await db.admin.query('SELECT count FROM access.write_rate_counter WHERE count > 0')).rows).toEqual([
        { count: 18 * units },
      ]);
      console.info(
        report.name,
        report.samples.map(({ scale, cost }) => ({
          routes: scale * 8 + 2,
          backgroundRows: scale * 256,
          statements: cost.statements,
          rows: cost.relations?.['access.write_rate_counter']?.rows,
          blocks: cost.blocks,
        })),
      );
    }
  } finally {
    lookup.mockRestore();
  }
}, 60000);
