import { expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import { createPublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import { complete, fixture, nativeProducer, readContext } from './support/public-filter-source.ts';

test('empty type catalogues cannot configure a Source while a compiled catalogue can project empty data', async () => {
  const f = await fixture();
  try {
    const { publicFilterSource } = await nativeProducer();
    const source = publicFilterSource(f.config);
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const subject = await f.create('schema:Book');
    const capture = { sort: 'id' as const, size: 10, filterDocument: undefined, text: undefined };
    const emptyRelease = structuredClone(f.meaning.release);
    emptyRelease.types = {};
    const emptyMeaning = { digest: releaseDigest(emptyRelease), release: emptyRelease };
    const snapshot = async () => {
      const sources = await f.db.admin.query(
        'SELECT to_jsonb(s) AS row FROM semantic.public_filter_source s ORDER BY partition_no,source_id',
      );
      const definitions = await f.db.admin.query(
        'SELECT to_jsonb(d) AS row FROM semantic.public_filter_read_definition d ORDER BY partition_no,read_definition',
      );
      return { sources: sources.rows, definitions: definitions.rows };
    };
    const before = await snapshot();
    expect(await binding.resolve({ source, meaning: emptyMeaning, capture }, readContext())).toMatchObject({
      status: 'unavailable',
      reason: 'binding_mismatch',
    });
    await expect(source.readPublicFilterProjectionPage({
      subject,
      meaning: emptyMeaning,
      inputLimit: 16,
      frontier: null,
      context: readContext(),
    })).rejects.toBeInstanceOf(TypeError);
    expect(await snapshot()).toEqual(before);

    const resolved = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    expect(resolved.status).toBe('resolved');
    const projected = await complete(f, source, subject);
    expect(projected.page.status).toBe('complete');
    expect(projected.records).toEqual([]);
  } finally {
    await f.close();
  }
});
