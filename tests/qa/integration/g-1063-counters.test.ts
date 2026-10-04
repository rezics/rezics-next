import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { RecommendationUnavailable } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import type { ProjectedWork } from '../../../services/main/src/modules/discovery/contract.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
test('G1063: delta counters count each Work once per Concept, retain more than three tags, and reject foreign delta Works', async () => {
  const f = await startMediaStack('g-1063-counters');
  try {
    const projection = new DiscoveryProjection(f.accessPool),
      operator = automaticDiscovery(null);
    const position = { dataEpoch: f.env.lineage.dataEpoch, sequence: '0' };
    const basis = { scope: 'global' as const, realm: null, context: native(), owner: null };
    const concepts = [native(), native(), native()],
      senses = Array.from({ length: 4 }, native);
    const item: ProjectedWork = {
      work: native(),
      revision: native(),
      mainVersion: native(),
      types: ['https://schema.org/Book'],
      recentOrder: '10',
      rating: null,
      primaryCredits: [],
      classifications: senses.map((sense, i) => ({
        sense,
        concept: concepts[Math.max(0, i - 1)]!,
        decision: native(),
        source: 'global' as const,
      })),
    };
    const prior = await projection.register(operator, basis, position, {
      idempotencyKey: randomUUID(),
      requestDigest: 'd'.repeat(64),
    });
    const initial = await projection.beginStep(operator, prior.generation_id, '');
    const ready = await projection.commitBatch(
      operator,
      prior.generation_id,
      initial.lease,
      '',
      { after: item.work, complete: true, items: [item] },
      position,
    );
    expect((await projection.conceptCounts(ready, concepts)).map((row) => row.work_count)).toEqual([
      '1',
      '1',
      '1',
    ]);
    expect(await projection.workTerms(ready, [item.work])).toHaveLength(4);
    const second: ProjectedWork = {
      ...item,
      work: native(),
      revision: native(),
      mainVersion: native(),
      recentOrder: '5',
      classifications: [item.classifications[1]!],
    };
    const works = [item.work, second.work].sort();
    const delta = await projection.register(
      operator,
      basis,
      position,
      { idempotencyKey: randomUUID(), requestDigest: 'e'.repeat(64) },
      { generation: ready.generation_id, works },
    );
    const lease = await projection.beginStep(operator, delta.generation_id, '');
    await expect(
      projection.commitBatch(
        operator,
        delta.generation_id,
        lease.lease,
        '',
        { after: works.at(-1)!, complete: true, items: [{ ...item, work: native() }] },
        position,
      ),
    ).rejects.toBeInstanceOf(RecommendationUnavailable);
    await projection.releaseStep(operator, delta.generation_id, lease.lease);
    const replacement = await projection.beginStep(operator, delta.generation_id, '');
    const next = await projection.commitBatch(
      operator,
      delta.generation_id,
      replacement.lease,
      '',
      {
        after: works.at(-1)!,
        complete: true,
        items: [{ ...item, classifications: item.classifications.slice(1) }, second],
      },
      position,
    );
    expect(next.work_count).toBe('2');
    const currentCounts = new Map(
      (await projection.conceptCounts(next, concepts)).map((row) => [row.concept, row.work_count]),
    );
    expect(currentCounts.get(concepts[0]!)).toBe('2');
    expect(currentCounts.get(concepts[1]!)).toBe('1');
    expect(currentCounts.get(concepts[2]!)).toBe('1');
    expect(
      (await projection.selectedTerms(next, senses))
        .map((row) => [row.term, row.work_count])
        .sort(),
    ).toEqual(
      [
        [senses[1]!, '2'],
        [senses[2]!, '1'],
        [senses[3]!, '1'],
      ].sort(),
    );
    expect(await projection.selectedTerms(ready, senses)).toHaveLength(4);
    expect((await projection.conceptCounts(ready, concepts)).map((row) => row.work_count)).toEqual([
      '1',
      '1',
      '1',
    ]);
    expect(await projection.page(ready, 'recent', '', '', 20)).toHaveLength(1);
    expect(await projection.page(next, 'recent', '', '', 20)).toHaveLength(2);
    // Model a crash/fault boundary that marks a staged delta failed after its
    // first batch. The next registration must restore its parent intervals.
    const key = () => ({ idempotencyKey: randomUUID(), requestDigest: 'f'.repeat(64) });
    const failed = await projection.register(operator, basis, position, key(), {
      generation: next.generation_id,
      works: [second.work],
    });
    const failedStep = await projection.beginStep(operator, failed.generation_id, '');
    await projection.commitBatch(
      operator,
      failed.generation_id,
      failedStep.lease,
      '',
      { after: second.work, complete: false, items: [] },
      position,
    );
    await f.accessPool.query(
      `UPDATE access.derived_generation SET state='failed',lease_expires_at=NULL,
      finished_at=clock_timestamp(),failure_reason='G1063 injected failure' WHERE id=$1`,
      [failed.generation_id],
    );
    const retried = await projection.register(operator, basis, position, key(), {
      generation: next.generation_id,
      works: [second.work],
    });
    const retryStep = await projection.beginStep(operator, retried.generation_id, '');
    const partial = await projection.commitBatch(
      operator,
      retried.generation_id,
      retryStep.lease,
      '',
      { after: second.work, complete: false, items: [] },
      position,
    );
    expect(partial.work_count).toBe('1');
    await projection.cancel(operator, retried.generation_id);
    expect(await projection.page(next, 'recent', '', '', 20)).toHaveLength(2);
    expect(
      new Map(
        (await projection.conceptCounts(next, concepts)).map((row) => [
          row.concept,
          row.work_count,
        ]),
      ).get(concepts[0]!),
    ).toBe('2');
  } finally {
    await f.stop();
  }
}, 60_000);
