import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readRestoredGraphReleaseExpectation, readRestoredGraphReleaseProof } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { withRetainedErasureRestoreScenario, recordRetainedErasureFailure } from './retained-erasure-recovery-fixture.ts';

test('OPS11/OPS12/IAM11/SEARCH20: retained erasure release refuses resurrected payloads, altered supersession and detached pins', async () => {
  await withRetainedErasureRestoreScenario(async scenario => {
    const {
      relay, third, payload, staleTarget, laterPreparation, originalPayload, ownerErasure,
      exact, bindCandidate, expectBothHoldsClosed, ownerOperationFor, interruptBeforeOwnerRelease,
    } = scenario;
    // Match the retained frontier reached by the stale-journal probes: each
    // fresh restore must replay both later erasures before closure is corrupted.
    await ownerErasure(staleTarget, 'stale-target');
    // Corruption probes use fresh copies of the final captured cut. Qualification commits
    // before the one-shot owner interruption, leaving both release holds closed.
    const sealedDeletionSet = third.deletionSet;
    if (!sealedDeletionSet) throw new Error('final retained Account deletion set is unavailable');
    const ownerRestoreInput = { sealedCoverage: third.authority.sealedCoverage,
      sealedDeletionSets: [sealedDeletionSet] };
    const expectComposedRefusal = async (mutate: (candidate: Awaited<ReturnType<typeof bindCandidate>>)
      => Promise<void>, reason: string) => {
      const candidate = await bindCandidate(third);
      try {
        const operations = ownerOperationFor(candidate, third);
        const key = `erasure-restore-owner-${randomUUID()}`;
        const { outerOperationId, outerId } = await interruptBeforeOwnerRelease(candidate, third, operations, key);
        await mutate(candidate);
        expect(await operations.reconcileRestore(ownerRestoreInput, key))
          .toMatchObject({ state: 'held', disposition: 'conflict' });
        expect((await relay.query<{ state: string; hold_reason: string | null }>(
          'SELECT state, hold_reason FROM relay.owner_reconciliation WHERE operation_id = $1',
          [outerOperationId])).rows[0]).toEqual({ state: 'held', hold_reason: reason });
        const bindings = (await relay.query<{ item_ref: string }>(`SELECT item_ref
          FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1
            AND item_ref LIKE 'restore-%' ORDER BY ordinal`, [outerId])).rows.map(row => row.item_ref);
        expect(bindings.filter(ref => ref.startsWith('restore-qualification:'))).toHaveLength(1);
        expect(bindings.filter(ref => ref.startsWith('restore-release:'))).toEqual([]);
        await expectBothHoldsClosed(candidate);
        const graphRelease = await readRestoredGraphReleaseExpectation(
          candidate.candidateGraph.fuseki, candidate.candidateGraph.lineage, third.coverage);
        expect(await readRestoredGraphReleaseProof(candidate.candidateGraph.fuseki, graphRelease)).toBeNull();
      } catch (error) {
        recordRetainedErasureFailure(error, 'corruption-probe');
        throw error;
      } finally { await candidate.dispose(); }
    };
    await expectComposedRefusal(async candidate => {
      const unsafe = await candidate.restored.content.connect();
      try {
        await unsafe.query('BEGIN');
        await unsafe.query('SET LOCAL session_replication_role = replica');
        await unsafe.query(`UPDATE content.revision SET availability = 'available',
          serialized_bytes = $2, body = $3 WHERE id = $1`,
        [payload, originalPayload.serialized_bytes, originalPayload.body]);
        await unsafe.query('COMMIT');
      } catch (error) {
        await unsafe.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { unsafe.release(); }
      expect(await exact(candidate.restored.content, payload)).toMatchObject({ status: 'available' });
    }, 'retained erasure reconciliation failed: restored Content still exposes an erased revision');
    await expectComposedRefusal(async candidate => {
      const supersession = (await candidate.restored.content.query<{ graph_sequence: string }>(
        `SELECT graph_sequence::text FROM content.publication_erasure_supersession
         WHERE operation_id = $1`, [laterPreparation])).rows[0];
      expect(supersession).toBeDefined();
      const altered = await candidate.restored.content.connect();
      try {
        await altered.query('BEGIN');
        await altered.query('SET LOCAL session_replication_role = replica');
        await altered.query(`UPDATE content.publication_erasure_supersession
          SET graph_sequence = graph_sequence + 1 WHERE operation_id = $1`, [laterPreparation]);
        await altered.query('COMMIT');
      } finally { altered.release(); }
    }, 'retained erasure reconciliation failed: restored publication supersession differs from erasure proof');
    await expectComposedRefusal(async candidate => {
      const detached = await candidate.restored.content.connect();
      try {
        await detached.query('BEGIN');
        await detached.query('SET LOCAL session_replication_role = replica');
        await detached.query(`UPDATE content.publication_preparation
          SET status = 'rejected', pin_active = false WHERE operation_id = $1`, [laterPreparation]);
        await detached.query('COMMIT');
      } finally { detached.release(); }
    }, 'retained erasure reconciliation failed: restored publication supersession differs from erasure proof');

  });
// Hang detector: measured 237 s unloaded, 304/358 s busy; well above 237 s on a quiet host is still a regression.
}, qaStartupTestTimeout(600_000));
