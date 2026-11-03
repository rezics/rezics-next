import { expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchWriteResult, Source } from '@rezics/definitions/bulk';
import { mapBangumiVocabulary } from '../../../../packages/conversion/src/bangumi-vocabulary.ts';
import type { NativeIdentity, SourceVocabularyInput } from '../../../../packages/conversion/src/source-vocabulary.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

type Candidate = {
  id: string;
  statement: { value: { type: string; content: unknown }; rank?: 'normal' | 'preferred' };
  head: number | null;
};
const source: Source = {
  source: 'bangumi', external_id: '900001', record_revision: '5', digest: 'c'.repeat(64),
  converter_revision: 'bangumi@4', field_group: 'facts',
};

test('mapped episode ordinal reaches an ordinary current-authority reader after accept and adoption', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const editor = await openApiObserver(runtime);
    const created = await runtime.importTransport.batch({ commands: [{
      op: 'create', source, key: 'source-vocabulary-episode-create',
      subject: { type: 'schema:Episode', labels: { en: 'Episode 1.5' } },
    }] });
    const createResult = created.results[0];
    expect(createResult?.status).toBe(201);
    if (!createResult || !('value' in createResult) || !('id' in createResult.value)) throw new Error('Missing native episode identity');
    const episodeId = createResult.value.id;
    const episode: NativeIdentity = { id: episodeId, type: 'schema:Episode', releaseDigest: bundledDigest };

    const mappingInput: SourceVocabularyInput = {
      metadata: {
        provider: 'bangumi', sourceAlias: 'bangumi', externalId: '900001', recordRevision: '5',
        digest: source.digest, converterRevision: source.converter_revision,
        recordUrl: 'https://bgm.tv/episode/900001', license: 'CC-BY-SA-3.0', attribution: 'Bangumi contributors',
      },
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
      rows: [{ kind: 'episode-sort', path: '/episode/900001/sort', episode, sort: '1.5' }],
    };
    const mapped = mapBangumiVocabulary(mappingInput);
    expect(mapped.gaps).toEqual([]);
    expect(mapped.proposals).toHaveLength(1);
    const published: BatchWriteResult = await runtime.importTransport.batch({ commands: [...mapped.proposals] });
    expect(published.results).toHaveLength(1);
    expect(published.results[0]?.status).toBe(201);

    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'], valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const query = new URLSearchParams({ property: 'schema:episodeNumber', context: GLOBAL_CONTEXT, limit: '100' });
    const page = await editor.http(`/v1/subjects/${episodeId}/candidates?${query}`);
    expect(page.status).toBe(200);
    const listing = page.body as unknown as { candidates: Candidate[]; adoption: { head: number } | null };
    expect(listing.candidates).toHaveLength(1);
    const candidate = listing.candidates[0]!;
    const accepted = await editor.http(`/v1/subjects/${episodeId}/candidates/${candidate.id}:accept`, {
      context: GLOBAL_CONTEXT, expected_head: candidate.head,
    });
    expect(accepted.status).toBe(200);
    const adopted = await editor.http(`/v1/subjects/${episodeId}:adopt`, {
      context: GLOBAL_CONTEXT, property: 'schema:episodeNumber', mode: 'replace',
      expected_head: listing.adoption?.head ?? null,
      selection: [{ candidate: candidate.id, rank: candidate.statement.rank ?? 'normal' }],
    });
    expect(adopted.status).toBe(200);

    const read = await runtime.request(`/v1/subjects/${episodeId}?context=${GLOBAL_CONTEXT}`);
    expect(read.status).toBe(200);
    const view = (await read.json()) as { subject: { statements: Record<string, { value: { content: unknown } }[]> } };
    expect(view.subject.statements['schema:episodeNumber']?.map((statement) => statement.value.content)).toEqual(['1.5']);
    const commands = published.results.flatMap((result) => result.status < 400 ? [result.key] : []);
    expect(commands).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});
