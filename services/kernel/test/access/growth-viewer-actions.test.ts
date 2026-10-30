import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createKernel } from '../../src/http/kernel.ts';
import { checkGrowth } from '../support/growth.ts';
import { createViewerActionsDriver } from './viewer-actions-outcomes-driver.ts';
import type { ResourceReference, ViewerActionsResponse } from '../../../../specs/viewer-actions-driver.ts';

test('composition names a resource type exceeding its candidate or operation bound', async () => {
  const pool = new Pool({ connectionString: 'postgres://invalid/composition' });
  try {
    for (const [actions, bindings] of [
      [65, 65],
      [1, 257],
    ]) {
      expect(() =>
        createKernel({
          pool,
          routeKey: new Uint8Array(32),
          modules: [
            (app) => {
              for (let i = 0; i < bindings!; i++)
                app.get(
                  `/fixture/bound/${i}`,
                  {
                    detail: {
                      operationId: `fixture.bound${i}`,
                      ...{
                        'x-action': `fixture:bound_${String.fromCharCode(97 + ((i % actions!) % 26))}${String.fromCharCode(97 + Math.floor((i % actions!) / 26))}`,
                        'x-resource-types': ['viewer_fixture.excess'],
                        'x-exposure': 'public',
                      },
                      security: [{ bearerAuth: [] }],
                    },
                  },
                  () => ({}),
                );
            },
          ],
        }),
      ).toThrow(/viewer_fixture.excess: viewer actions exceed/);
    }
  } finally {
    await pool.end();
  }
});

test('closed gates share the batch principal preparation and authoritative instant', async () => {
  const driver = await createViewerActionsDriver();
  try {
    const f = await driver.fixture();
    for (const group of ['collections', 'viewer_alpha', 'viewer_zulu']) await driver.gate(group, false);
    await driver.grantGate(f.assigned, 'any');
    await driver.grantGate(f.principal, 'any');
    const measured = await driver.measure(async () => {
      const response = await driver.request(f.assigned.credential, '/v1/viewerActions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resources: [f.collection, f.realm, f.item] }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return (await response.json()) as ViewerActionsResponse;
    });
    expect(measured.value.resources[0]).toMatchObject({
      ...f.collection,
      viewerActions: expect.arrayContaining([expect.objectContaining({ action: 'collection:update' })]),
    });
    expect(measured.trace.preparations).toEqual({ actor: 1, principal: 1, gates: 1 });
    expect(new Set(measured.trace.readTimes).size).toBe(1);
  } finally {
    await driver.close();
  }
}, 120_000);

test('viewer actions keep bounded work for mixed types and every outcome over independent growth axes', async () => {
  const driver = await createViewerActionsDriver();
  try {
    for (const axis of ['unrelated_grants', 'unrelated_resources', 'history'] as const) {
      const f = await driver.fixture();
      const refs = [f.collection, f.realm, f.item, ...(await driver.additionalCollections(f.curator, 97))];
      const send = async (credential: string, resources: ResourceReference[], status = 200) => {
        const response = await driver.request(credential, '/v1/viewerActions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resources }),
        });
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        return await response.json();
      };
      let expected: ViewerActionsResponse | undefined;
      const report = await checkGrowth(driver.database, {
        name: `Personal viewer actions: ${axis}`,
        scales: [1, 4, 16],
        repetitions: 3,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(_database, scale) {
          await driver.seed(f, scale, axis);
        },
        async operation() {
          const allowed = await send(f.assigned.credential, refs);
          if (expected) expect(allowed).toEqual(expected);
          else expected = allowed;
          const denied = await send(f.stranger.credential, refs);
          expect(
            denied.resources[0].viewerActions.some((entry: { action: string }) => entry.action === 'collection:update'),
          ).toBe(false);
          expect(await send(f.stranger.credential, [f.item])).toEqual({
            resources: [{ ...f.item, viewerActions: [] }],
          });
          await driver.fault(f.item);
          try {
            expect(await send(f.editor.credential, [f.collection, f.item], 503)).toHaveProperty(
              'code',
              'dependency_unavailable',
            );
          } finally {
            await driver.fault(null);
          }
        },
      });
      expect(report.samples).toHaveLength(3);
    }
  } finally {
    await driver.close();
  }
}, 600_000);
