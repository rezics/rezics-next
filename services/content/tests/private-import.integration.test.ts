import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentConflict, ContentCore, contentDraftIntentDigest, type VariantIdentity } from '../src/core.ts';
import { migrateContent } from '../src/migrate.ts';

test('private imported Content binds its exact source and transcriber without claiming authorship or publication rights', async () => {
  const cluster = await startPostgresCluster(), pool = new Pool({ ...cluster.connection, max: 8 });
  try {
    await migrateContent(pool);
    const core = new ContentCore(pool);
    const variant: VariantIdentity = { id: `urn:rezics:variant:${crypto.randomUUID()}`,
      resourceId: `https://rezics.com/id/${crypto.randomUUID()}`,
      language: { kind: 'tag', tag: 'und', originalTag: 'und' }, direction: 'ltr' };
    const source = { sourceObservation: `https://rezics.com/id/${crypto.randomUUID()}`, sourceDigest: 'a'.repeat(64) };
    const command = { operationId: 'private-import', variant, expectedHead: null,
      model: 'content-shape-v1', sourceRevision: source.sourceObservation, serializedJson: '{"body":"Private imported recipe."}',
      provenance: { kind: 'admitted-private-import-v1', transcriber: `https://rezics.com/id/${crypto.randomUUID()}`,
        rightsBasis: 'unknown', ...source, admissionId: crypto.randomUUID(), authorityEpoch: '1',
        scope: `content:draft:${variant.resourceId}`, expectedHead: null, requestDigest: '' } };
    command.provenance.requestDigest = contentDraftIntentDigest(command, command.provenance.transcriber, source);
    const saved = await core.saveDraft(command);
    expect(saved.outcome).toBe('succeeded');
    expect((await core.saveDraft(command)).replayed).toBe(true);
    await expect(core.saveDraft({ ...command, operationId: 'forged-import-source', provenance: {
      ...command.provenance, sourceDigest: 'b'.repeat(64),
    } })).rejects.toBeInstanceOf(ContentConflict);
    await expect(core.saveDraft({ ...command, operationId: 'forged-import-text',
      serializedJson: '{"body":"Changed text."}' })).rejects.toBeInstanceOf(ContentConflict);
    const exact = (await core.readExactBatch([saved.revisionId!], async ids => new Set(ids)))[0]!;
    expect(exact.status).toBe('available');
    if (exact.status === 'available') {
      expect(exact.reference.provenance).toEqual(command.provenance);
      await expect(core.preparePublication('publish-private-import', saved.revisionId!, exact.reference.byteDigest))
        .rejects.toBeInstanceOf(ContentConflict);
    }
  } finally { await pool.end(); cluster.remove(); }
});
