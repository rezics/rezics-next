import { expect, test } from 'bun:test';
import { scopedExportFixture, type Manifest } from './export-scoped-support.ts';
import { nativeId } from './scoped-judgments-support.ts';

test('DQV exports identify each measurement and name only formula contributors as computedOn', async () => {
  const f = await scopedExportFixture();
  try {
    const measurement = (manifest: Manifest) =>
      manifest.plan.members[0]!.data!.representation as Record<string, unknown>;
    const aggregate = measurement(
      await f.json<Manifest>(await f.exportSelection(f.selection), 201),
    );
    const rejected = nativeId();
    const pooled = measurement(
      await f.json<Manifest>(
        await f.exportSelection({
          kind: 'rating-rollup',
          reference: f.context.context,
          targets: [f.projection.id, rejected],
          formula: 'pooled',
          expectedPosition: f.aggregate.sourcePosition,
        }),
        201,
      ),
    );
    const means = measurement(
      await f.json<Manifest>(
        await f.exportSelection({
          kind: 'rating-rollup',
          reference: f.context.context,
          targets: [f.projection.id, rejected],
          formula: 'mean-of-means',
          expectedPosition: f.aggregate.sourcePosition,
        }),
        201,
      ),
    );
    expect(pooled['dqv:computedOn']).toEqual([{ id: f.projection.id }]);
    expect(means['dqv:computedOn']).toEqual([]);
    for (const item of [aggregate, pooled, means]) {
      expect(item.id).toMatch(/^urn:rezics:quality-measurement:[a-f0-9]{64}$/);
      expect(item.id).not.toBe(f.context.context);
      expect(item.id).not.toBe(f.projection.id);
    }
    expect(new Set([aggregate.id, pooled.id, means.id]).size).toBe(3);
    expect(pooled['rv:members']).toContainEqual(
      expect.objectContaining({ target: { id: rejected }, status: 'unavailable' }),
    );
  } finally {
    await f.stop();
  }
}, 180_000);
