import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore, ContentConflict } from '../src/core.ts';
import { migrateContent } from '../src/migrate.ts';
import { ContentDerivationStale, type ContentDerivationInput } from '../src/derivation.ts';

test('Content derivation custody refuses denied/stale writes, pins revisions, preserves bytes and replays exactly', async () => {
  const cluster = await startPostgresCluster(); const pool = new Pool({ ...cluster.connection, max: 4 });
  try {
    await migrateContent(pool); const core = new ContentCore(pool);
    const target = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
    const variant = { id: variantId, resourceId: target, language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
    const save = (text: string, head: string | null) => core.saveDraft({ operationId: randomUUID(), variant,
      expectedHead: head, model: 'content-shape-v1', sourceRevision: null, provenance: {}, serializedJson: JSON.stringify({ body: text }) });
    const first = await save('Exact source', null), output = await save('Derived output', first.revisionId!);
    const exactBefore = (await core.readExactBatch([output.revisionId!], async ids => new Set(ids)))[0];
    const input: ContentDerivationInput = { output: { target, selector: { grain: 'content', variantId, revision: output.revisionId! } },
      inputs: [{ target, selector: { grain: 'content', variantId, revision: first.revisionId! } }],
      expectedOutputHead: output.revisionId!, activity: { kind: 'transformation' }, responsibleAgent: `https://rezics.com/id/${randomUUID()}` };
    let proofs = 0; const prove = async () => { proofs++; };
    await expect(core.derivations.record('denied', input, 'software', async () => { throw new Error('authority denied'); })).rejects.toThrow('authority denied');
    expect(await core.derivations.page(output.revisionId!, 20, null)).toEqual([]);
    const saved = await core.derivations.record('one', input, 'software', prove);
    expect(saved.replayed).toBe(false); expect(saved.inputs[0]!.selector).toMatchObject({ revision: first.revisionId });
    expect(await core.derivations.record('one', structuredClone(input), 'software', prove)).toEqual({ ...saved, replayed: true });
    await expect(core.derivations.record('one', { ...input, activity: { kind: 'translation' } }, 'software', prove)).rejects.toBeInstanceOf(ContentConflict);
    expect(proofs).toBe(2);
    await expect(core.derivations.record('wrong-input-owner', { ...input, inputs: [{ ...input.inputs[0]!,
      target: `https://rezics.com/id/${randomUUID()}` }] }, 'software', prove)).rejects.toBeInstanceOf(ContentConflict);
    expect(proofs).toBe(2);
    const exactAfter = (await core.readExactBatch([output.revisionId!], async ids => new Set(ids)))[0];
    expect(exactAfter).toEqual(exactBefore);
    expect(await core.derivations.page(output.revisionId!, 1, null)).toEqual([{ ...saved, replayed: undefined }].map(({ replayed: _replayed, ...record }) => record));
    await save('Private successor', output.revisionId!);
    await expect(core.derivations.record('stale', input, 'software', prove)).rejects.toBeInstanceOf(ContentDerivationStale);
    expect((await core.derivations.record('one', input, 'software', prove)).replayed).toBe(true);
    await expect(pool.query('UPDATE content.derivation SET request_digest=$1 WHERE id=$2', ['0'.repeat(64), saved.derivation])).rejects.toThrow('immutable Content record');
    const record = (await core.derivations.page(output.revisionId!, 20, null))[0]!;
    expect(JSON.stringify(record)).not.toContain('operation_id'); expect(JSON.stringify(record)).not.toContain('principal');
  } finally { await pool.end(); cluster.remove(); }
}, 60_000);
