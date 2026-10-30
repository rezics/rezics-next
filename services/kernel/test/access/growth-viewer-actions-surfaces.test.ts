import { expect, test } from 'bun:test';
import { checkGrowth } from '../support/growth.ts';
import { createViewerActionsSurfacesDriver } from './viewer-actions-surfaces-driver.ts';
import type { ViewerActionsResponse } from '../../../../specs/viewer-actions-surfaces-driver.ts';

test('displayed subject batches include native visibility gates and formula work over independent growth axes', async () => {
  const driver = await createViewerActionsSurfacesDriver();
  try {
    for (const axis of ['subjects', 'grants', 'history'] as const) {
      const f = await driver.fixture();
      const refs = [...f.subjects.slice(0, 19), f.concealed];
      const unscoped = await f.unscoped('follow:create');
      const expected = new Map<string | null, ViewerActionsResponse>();
      const report = await checkGrowth(driver.database, {
        name: `Displayed subject viewer actions: ${axis}`,
        scales: [64, 256, 1024],
        repetitions: 3,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(_database, scale) {
          await driver.seed(f, scale, axis);
        },
        async operation() {
          for (const credential of [null, f.alice.credential, unscoped.credential]) {
            const response = await driver.request(credential, '/v1/viewerActions', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ resources: refs }),
            });
            expect(response.status).toBe(200);
            expect(response.headers.get('cache-control')).toBe('private, no-store');
            const body = (await response.json()) as ViewerActionsResponse;
            expect(body.resources).toHaveLength(20);
            expect(body.resources[19]).toEqual({ ...f.concealed, error: 'not_found' });
            const actions = body.resources[0]!.viewerActions!;
            expect(actions).toHaveLength(credential === null ? 0 : credential === f.alice.credential ? 4 : 3);
            if (credential === unscoped.credential)
              expect(actions.some(({ action }) => action === 'follow:create')).toBe(false);
            if (expected.has(credential)) expect(body).toEqual(expected.get(credential)!);
            else expected.set(credential, body);
          }
        },
      });
      expect(report.samples).toHaveLength(3);
    }
  } finally {
    await driver.close();
  }
}, 600_000);
