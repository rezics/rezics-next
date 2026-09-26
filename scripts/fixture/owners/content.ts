import { type Corpus, FIXTURE_FORMAT, IMPORTED_AT, RecordDigest, corpusWorks, sha256,
  stable } from '../corpus.ts';
import { countRows, insertColumns, ownerTransaction } from './postgres.ts';
import type { FixtureOwner } from './types.ts';

/** One exact draft revision per Work, in the byte form saveAdmittedContentDraft stores. */
function* revisions(corpus: Corpus) {
  const provenance = JSON.stringify({ kind: 'fixture-import-v1', fixture: FIXTURE_FORMAT,
    operation: corpus.importOperation });
  for (const work of corpusWorks(corpus)) {
    const serialized = JSON.stringify({ body: work.contentBody });
    const bytes = Buffer.from(serialized, 'utf8');
    yield { work, variant: [work.variant, work.work, 'tag', work.language, work.language, 'ltr', IMPORTED_AT],
      revision: [work.contentRevision, work.variant, `${corpus.importOperation}:content:${work.index}`,
        'rezics-content-json-v1', 'content-shape-v1', provenance, sha256(bytes), bytes.length, bytes,
        serialized, IMPORTED_AT] as unknown[] };
  }
}

export const contentOwner: FixtureOwner = {
  name: 'content',
  generator: 'content-work-draft-v1',
  phase: 'online',
  compatibilityInputs: () => ({}),
  summarize(corpus) {
    const digest = new RecordDigest();
    for (const row of revisions(corpus)) {
      digest.add('content.variant', stable(row.variant));
      digest.add('content.revision', stable(row.revision.map(value =>
        Buffer.isBuffer(value) ? value.toString('base64') : value)));
    }
    return digest.finish();
  },
  async load(corpus, target) {
    const started = performance.now();
    const rows = await ownerTransaction(target.pools.content, async client => {
      const variants = await insertColumns(client, `INSERT INTO content.variant
        (id, resource_id, language_kind, language_tag, original_language_tag, direction, created_at)
        SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
          $7::timestamptz[])`, (function* () { for (const row of revisions(corpus)) yield row.variant; })(), 7);
      const saved = await insertColumns(client, `INSERT INTO content.revision
        (id, variant_id, operation_id, format, model, provenance, byte_digest, byte_length,
          serialized_bytes, body, created_at)
        SELECT id, variant, operation, format, model, provenance::jsonb, digest, length, bytes,
          body::jsonb, created FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[],
          $6::text[], $7::text[], $8::int[], $9::bytea[], $10::text[], $11::timestamptz[])
          AS row(id, variant, operation, format, model, provenance, digest, length, bytes, body, created)`,
      (function* () { for (const row of revisions(corpus)) yield row.revision; })(), 11);
      const heads = await insertColumns(client, `UPDATE content.variant AS variant
        SET draft_head = head.revision FROM unnest($1::text[], $2::uuid[]) AS head(variant, revision)
        WHERE variant.id = head.variant`,
      (function* () { for (const row of revisions(corpus)) yield [row.work.variant, row.work.contentRevision]; })(), 2);
      return { variants, revisions: saved, heads };
    });
    return { elapsedMs: performance.now() - started, detail: rows };
  },
  async verify(_corpus, target) {
    const pool = target.pools.content;
    // No fabricated draft receipts or outbox events; the owner position stays at 0.
    for (const table of ['content.receipt', 'content.outbox']) {
      if (await countRows(pool, table) !== 0) throw new Error(`${table} must stay empty after import`);
    }
    const heads = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM content.variant WHERE draft_head IS NOT NULL');
    return { 'content.variant': Number(heads.rows[0]?.n),
      'content.revision': await countRows(pool, 'content.revision') };
  },
};
