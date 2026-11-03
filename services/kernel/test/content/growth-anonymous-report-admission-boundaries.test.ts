import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import {
  axes, branches, createAdmissionFixture,
} from './support/growth-anonymous-report-admission-boundaries-fixture.ts';

let fixture: Awaited<ReturnType<typeof createAdmissionFixture>>;
beforeAll(async () => { fixture = await createAdmissionFixture(); }, 180_000);
afterAll(async () => { await fixture?.close(); });

for (const axis of axes) for (const branch of branches) {
  test(`anonymous report ${branch} admission stays bounded as unrelated ${axis} grow`, async () => {
    const f = fixture;
    await f.visibility(branch === 'revoked');
    const population = f.population(axis, branch);
    const before = await f.snapshot();
    const totals = await f.totals();
    expect(before).toEqual(f.baseline);
    const callsBefore = f.providerCalls;
    let runs = 0;
    try {
      const report = await checkGrowth(f.db, {
        name: `anonymous report ${branch} admission / ${axis}`,
        scales: [32, 256, 2048],
        repetitions: 3, warmups: 1,
        rule: 'series',
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        grow: (_db, scale, previous) => population.grow(scale, previous),
        async operation(observed) {
          expect(observed.pool).toBe(f.db.pool);
          // Includes shared rate admission, HTTP verifier, current disclosure/Access,
          // command receipt lookup/conflict and every failed native statement.
          const result = await f.run(branch);
          runs++;
          if (branch === 'replay') {
            expect(result.status).toBe(201);
            expect(result.body.reportId).toBe(f.selected.id);
          } else {
            const status = branch === 'unavailable' ? 503 : branch === 'conflict' ? 422 : branch === 'revoked' ? 404 : 403;
            expect(result.status).toBe(status);
            expect(result.body).toMatchObject({ effect_status: 'not_applied' });
            if (branch === 'conflict') expect(result.body.code).toBe('idempotency_conflict');
            if (branch === 'revoked') expect(result.body.code).toBe('not_found');
            expect(result.body.reportId).toBeUndefined();
            const disclosed = JSON.stringify(result.body);
            expect(disclosed).not.toContain(f.selected.id);
            expect(disclosed).not.toContain(f.input.evidence);
          }
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
      for (const sample of report.samples) for (const cost of sample.repetitions) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.blocks).toBeGreaterThan(0);
        expect(cost.statements).toBeGreaterThan(0);
        expect(cost.plans).toBeGreaterThan(0);
        // Provider outage exits before disclosure; it still performs native shared rate admission.
        if (branch !== 'unavailable') expect(cost.relations['content.board']).toBeDefined();
        if (branch === 'replay' || branch === 'conflict') expect(cost.relations['core.receipt']).toBeDefined();
        if (branch !== 'replay' && branch !== 'conflict') {
          expect(cost.relations['core.receipt']).toBeUndefined();
          expect(cost.relations['content.report']).toBeUndefined();
        }
      }
      assertGrowthAccessPaths(report.name, report.samples, ['content.board', 'core.receipt', 'access.resource_grant']);
      expect(f.providerCalls - callsBefore).toBe(branch === 'missing' ? 0 : runs);
      // No command result is fabricated for rejected admission. One selected HTTP
      // report, receipt and registered projection survive every replay/denial unchanged.
      expect(await f.snapshot()).toEqual(before);
      const retained = JSON.stringify(await f.snapshot());
      for (const proof of f.proofs) expect(retained).not.toContain(proof);
      expect(retained).not.toContain('invalid-proof');
      expect(retained).not.toContain('provider-unavailable');
      await population.clear();
      // Also catches malformed/partial receipts or unexpected report identities,
      // which cannot be found by looking only for the selected report reference.
      expect(await f.totals()).toEqual(totals);
      console.info(JSON.stringify(report));
    } finally {
      await population.clear();
      await f.visibility(false);
    }
  }, 180_000);
}
