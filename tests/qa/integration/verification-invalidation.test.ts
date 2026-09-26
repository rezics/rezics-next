import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { VerificationConflict, VerificationInvalid, VerificationStore,
  nativeId } from '../../../services/main/src/modules/verification/store.ts';

test('FACT04: a popular source invalidation pages, resumes and records one effect per target', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  try {
    await migrateContent(pool);
    const store = new VerificationStore(pool);
    // Integration files can share a disposable database. Settle earlier tests'
    // queue work before measuring this event's pages.
    for (let batch = 0; batch < 20; batch++) {
      const settled = await store.processInvalidations('fact04-preflight', { pageSize: 200, maxPages: 20 });
      if (settled.pages === 0) break;
      if (batch === 19) throw new Error('prior integration invalidations did not settle within the test budget');
    }
    const scope = nativeId(randomUUID());
    const original = nativeId(randomUUID());
    const corrected = nativeId(randomUUID());
    const context = 'urn:rezics:context:fact04-fanout';
    const targets = Array.from({ length: 205 }, () => nativeId(randomUUID()));
    for (const target of targets) {
      const activation = await store.activateSummary({ target, context, claim: target,
        claimRevision: nativeId(randomUUID()), adoptedRevision: null,
        assessment: nativeId(randomUUID()), policyRevision: 'urn:rezics:policy:fact04-v1',
        support: 'supported', review: 'reviewed', coverage: 'complete', dependence: 'established',
        reasons: ['source-reviewed'], dependencies: [{ owner: 'graph', kind: 'source-assessment',
          reference: scope, expectedHead: original }], ownerPositions: {},
        operationKey: `fact04:${randomUUID()}`, expectedActive: null, observedDemand: null,
        openChallenges: 0, resolvedChallenges: 0 });
      expect(activation.status).toBe('activated');
    }

    const event = `urn:rezics:event:fact04:${randomUUID()}`;
    const position = { dataEpoch: randomUUID(), sequence: '20' };
    expect(await store.recordGraphInvalidation(event, 'source-assessment', scope, corrected, position)).toBe(true);
    expect(await store.recordGraphInvalidation(event, 'source-assessment', scope, corrected, position)).toBe(false);
    await expect(store.recordGraphInvalidation(event, 'source-assessment', scope, original, position))
      .rejects.toBeInstanceOf(VerificationConflict);
    await expect(store.processInvalidations('fact04', { pageSize: 201, maxPages: 1 }))
      .rejects.toBeInstanceOf(VerificationInvalid);
    await expect(store.processInvalidations('fact04', { pageSize: 1, maxPages: 21 }))
      .rejects.toBeInstanceOf(VerificationInvalid);

    const planResult = await pool.query<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
      SELECT target, context FROM verification.active_dependency
      WHERE kind = 'source-assessment' AND reference = $1
      ORDER BY target, context LIMIT 50`, [scope]);
    const plan = planResult.rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Actual Rows']).toBe(50);
    expect(JSON.stringify(plan)).toContain('active_dependency_pkey');

    await pool.query(`CREATE FUNCTION verification.fact04_injected_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fact04 injected page failure'; END $$`);
    await pool.query(`CREATE TRIGGER fact04_injected_page_failure BEFORE INSERT
      ON verification.invalidation_effect FOR EACH ROW
      EXECUTE FUNCTION verification.fact04_injected_failure()`);
    try {
      await expect(store.processInvalidations('fact04', { pageSize: 50, maxPages: 1 }))
        .rejects.toThrow('fact04 injected page failure');
      const rollback = await pool.query<{ state: string; cursor_target: string | null;
        effects: string }>(`SELECT i.state, i.cursor_target,
        (SELECT count(*)::text FROM verification.invalidation_effect WHERE invalidation_id = i.id) AS effects
        FROM verification.invalidation i WHERE i.event_key = $1`, [event]);
      expect(rollback.rows[0]).toEqual({ state: 'pending', cursor_target: null, effects: '0' });
    } finally {
      await pool.query('DROP TRIGGER fact04_injected_page_failure ON verification.invalidation_effect');
      await pool.query('DROP FUNCTION verification.fact04_injected_failure()');
    }

    const first = await store.processInvalidations('fact04', { pageSize: 50, maxPages: 1 });
    expect(first).toMatchObject({ pages: 1, rowsRead: 50, marked: 50, completed: 0 });
    const rest = await store.processInvalidations('fact04', { pageSize: 50, maxPages: 10 });
    expect(rest.rowsRead).toBe(155);
    expect(rest.marked).toBe(155);
    expect(rest.completed).toBe(1);
    expect(rest.pages).toBeLessThanOrEqual(4);
    expect(await store.processInvalidations('fact04', { pageSize: 50, maxPages: 1 }))
      .toMatchObject({ pages: 0, rowsRead: 0, marked: 0 });

    const state = await pool.query<{ effect_count: string; demand_count: string; mark_count: string }>(`
      SELECT (SELECT count(*)::text FROM verification.invalidation_effect e
        JOIN verification.invalidation i ON i.id = e.invalidation_id WHERE i.event_key = $1) AS effect_count,
        (SELECT count(*)::text FROM verification.reassessment_request WHERE context = $2) AS demand_count,
        (SELECT sum(marks)::text FROM verification.reassessment_request WHERE context = $2) AS mark_count`,
    [event, context]);
    expect(state.rows[0]).toEqual({ effect_count: '205', demand_count: '205', mark_count: '205' });
    const retained = await store.readSummary(targets[0]!, context);
    expect(retained).toMatchObject({ support: 'supported', review: 'reviewed', pendingWork: true });
    expect(retained?.dependencies).toHaveLength(1);
    expect(retained?.dependencies[0]?.expectedHead).toBe(original);
  } finally {
    await pool.end();
  }
}, 90_000);
