import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth } from '../support/growth.ts';
import { createGrowthDeletionFixture } from './support/deletion-fixture.ts';

let fixture: Awaited<ReturnType<typeof createGrowthDeletionFixture>>;
beforeAll(async () => {
  fixture = await createGrowthDeletionFixture();
});
afterAll(async () => {
  await fixture.close();
});
const person = () => fixture.person();
const proposal = (subject: string) => fixture.proposal(subject);

test('owned semantic deletion and restore stay bounded across unrelated history and population', async () => {
  const { db, call, status, path } = fixture;
  for (const axis of ['history', 'population'] as const) {
    const subject = await person();
    const unrelated = await person();
    const selected = await proposal(subject);
    status(await call('POST', `${path(selected)}:accept`, { context: GLOBAL_CONTEXT, expected_head: null }), 200);
    status(
      await call('POST', `/v1/subjects/${subject}:adopt`, {
        context: GLOBAL_CONTEXT,
        property: 'schema:url',
        mode: 'replace',
        selection: [{ candidate: selected.candidate, rank: 'normal' }],
        expected_head: null,
      }),
      200,
    );
    const report = await checkGrowth(db, {
      name: `semantic deletion and restore: ${axis}`,
      scales: [64, 512, 4096],
      repetitions: 1,
      warmups: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        // Native proposals grow the same subject's history; native creates grow other subjects.
        // Neither fixture installs SQL truth into a future lifecycle table.
        for (let i = previous; i < scale; i++) {
          if (axis === 'history') await proposal(subject);
          else await person();
        }
        await proposal(unrelated);
      },
      async operation() {
        status(await call('DELETE', path(selected)), 200);
        const deleted = await call('GET', `/v1/subjects/${subject}/candidates?property=schema%3Aurl&limit=1`);
        status(deleted, 200);
        expect(JSON.stringify(deleted.body)).not.toContain(selected.payload);
        const view = await call('GET', `/v1/subjects/${subject}`);
        status(view, 200);
        expect(JSON.stringify(view.body)).not.toContain(selected.payload);
        status(await call('POST', `${path(selected)}:restoreDeleted`, {}), 200);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  }
});
