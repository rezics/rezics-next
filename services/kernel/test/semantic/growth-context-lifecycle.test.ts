import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth } from '../support/growth.ts';
import { createGrowthDeletionFixture } from './support/deletion-fixture.ts';

let fixture: Awaited<ReturnType<typeof createGrowthDeletionFixture>>;
beforeAll(async () => {
  fixture = await createGrowthDeletionFixture();
});
afterAll(async () => {
  await fixture.close();
});

async function checkLifecycleGrowth(axis: 'history' | 'population') {
  const { db, call, status, person, proposal, path } = fixture;
  const createContext = async () => {
    const result = await call('POST', '/v1/contexts', { labels: { en: 'Independent Context' } });
    status(result, 201);
    return result.body.context.id as string;
  };
    const context = await createContext();
    const subject = await person();
    const selected = await proposal(subject);
    status(await call('POST', `${path(selected)}:accept`, { context, expected_head: null }), 200);
    status(
      await call('POST', `/v1/subjects/${subject}:adopt`, {
        context,
        property: 'schema:url',
        mode: 'replace',
        selection: [{ candidate: selected.candidate, rank: 'normal' }],
        expected_head: null,
      }),
      200,
    );
    const read = () => call('GET', `/v1/subjects/${subject}?context=${context}`);
    const visible = await read();
    status(visible, 200);
    expect(JSON.stringify(visible.body)).toContain(selected.payload);
    const report = await checkGrowth(db, {
      name: `semantic Context lifecycle: ${axis}`,
      scales: [64, 512, 4096],
      repetitions: 1,
      warmups: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        for (let i = previous; i < scale; i++) {
          if (axis === 'history') await proposal(subject);
          else await createContext();
        }
      },
      async operation() {
        // Capture the raw HTTP command, Access checks and current read checks together.
        // No relay or enumeration of subjects with an overlay can hide fanout work.
        const before = await read();
        status(before, 200);
        status(await call('GET', `/v1/contexts/${context}/definitions`), 200);
        status(await call('DELETE', `/v1/contexts/${context}`), 200);
        status(await call('GET', `/v1/contexts/${context}`), 404);
        status(await call('GET', `/v1/contexts/${context}/definitions`), 404);
        const withheld = await read();
        status(withheld, 404);
        expect(JSON.stringify(withheld.body)).not.toContain(selected.payload);
        status(await call('POST', `/v1/contexts/${context}:restore`, {}), 200);
        status(await call('GET', `/v1/contexts/${context}`), 200);
        status(await call('GET', `/v1/contexts/${context}/definitions`), 200);
        const restored = await read();
        status(restored, 200);
        expect(restored.body).toEqual(before.body);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
}

test('Context lifecycle cost stays bounded as subject history grows', async () => {
  await checkLifecycleGrowth('history');
});

test('Context lifecycle cost stays bounded as unrelated Context population grows', async () => {
  await checkLifecycleGrowth('population');
});
