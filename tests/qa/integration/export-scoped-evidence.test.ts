import { expect, test } from 'bun:test';
import { scopedExportFixture, type Manifest } from './export-scoped-support.ts';
import type { Opinion } from './scoped-judgments-support.ts';

test('exports pin sealed owner evidence across unrelated writes and reject same-value replacements', async () => {
  const f = await scopedExportFixture();
  try {
    const rollup = {
      kind: 'rating-rollup' as const,
      reference: f.context.context,
      targets: [f.projection.id],
      formula: 'pooled' as const,
      expectedPosition: f.aggregate.sourcePosition,
    };
    // POST, idempotent POST and GET must all ignore unrelated graph positions.
    await f.semantic('Unrelated write before export');
    const key = crypto.randomUUID();
    const aggregate = await f.json<Manifest>(await f.exportSelection(f.selection, key), 201);
    const derived = await f.json<Manifest>(await f.exportSelection(rollup), 201);
    expect(aggregate.plan.members[0]?.data?.ownerEvidence).toEqual({
      contextRevision: f.context.contextRevision,
      lastAdmissionId: f.aggregate.lastAdmissionId,
    });
    expect(derived.plan.members[0]?.data?.ownerEvidence).toEqual({
      contextRevision: f.context.contextRevision,
      members: [{ target: f.projection.id, lastAdmissionId: f.aggregate.lastAdmissionId }],
    });
    await f.semantic('Unrelated write after export');
    expect((await f.exportSelection(f.selection, key)).status).toBe(200);
    for (const manifest of [aggregate, derived])
      expect((await f.callExport('GET', `/v1/exports/${manifest.manifestId}`)).status).toBe(200);
    await f.json<Opinion>(
      await f.call(
        f.owner,
        'POST',
        '/v1/rating-observations',
        f.ratingBody(f.owner, f.context.context, f.projection.id, 8, f.own.observationRevision),
      ),
      201,
    );
    expect((await f.exportSelection(f.selection, key)).status).toBe(409);
    for (const manifest of [aggregate, derived])
      expect((await f.callExport('GET', `/v1/exports/${manifest.manifestId}`)).status).toBe(409);
  } finally {
    await f.stop();
  }
}, 180_000);
