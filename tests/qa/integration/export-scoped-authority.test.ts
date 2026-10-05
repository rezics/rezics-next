import { expect, test } from 'bun:test';
import { scopedExportFixture, type Manifest } from './export-scoped-support.ts';

test('export scope alone cannot authorize scoped aggregate or rollup owner reads', async () => {
  const f = await scopedExportFixture();
  try {
    const rollup = {
      kind: 'rating-rollup' as const,
      reference: f.context.context,
      targets: [f.projection.id],
      formula: 'pooled' as const,
      expectedPosition: f.aggregate.sourcePosition,
    };
    const manifests: Manifest[] = [];
    for (const selection of [f.selection, rollup])
      manifests.push(await f.json<Manifest>(await f.exportSelection(selection), 201));
    f.scopes.delete('rating:read');
    for (const selection of [f.selection, rollup])
      expect((await f.exportSelection(selection)).status).toBe(403);
    for (const manifest of manifests)
      expect((await f.callExport('GET', `/v1/exports/${manifest.manifestId}`)).status).toBe(403);
    f.scopes.add('rating:read');
    f.scopes.delete('work:read');
    // The scoped owner adapter requires rating authority, without silently
    // requiring an unrelated ordinary Work-read OAuth scope.
    for (const manifest of manifests)
      expect((await f.callExport('GET', `/v1/exports/${manifest.manifestId}`)).status).toBe(200);
    expect(f.verifiedScopes).toContainEqual(['rating:read']);
  } finally {
    await f.stop();
  }
}, 180_000);
