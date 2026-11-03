import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { SourceRecord } from '../../../../packages/conversion/src/index.ts';
import { Importer } from '../../../importer/src/importer.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import type { ImportTransport } from '../../../importer/src/import-contract.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { Statement } from '../../src/semantic/item.ts';
import { classificationQualifiersDigest } from '../../src/rating/register.ts';
import {
  createSourceStatisticLifecycleFixture,
  type SourceStatisticLifecycleFixture,
} from '../rating/source-statistic-lifecycle-fixture.ts';

let fixture: SourceStatisticLifecycleFixture;
beforeAll(async () => {
  fixture = await createSourceStatisticLifecycleFixture();
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

// Synthetic record shape for the VNDB registration; classification facts below are authored fixture data.
function vn(): SourceRecord {
  return {
    source: 'vndb',
    key: 'v123',
    revision: '7',
    payload: {
      vn: { id: 'v123', olang: 'en', c_average: 735, c_votecount: 20, c_rating: 900 },
      entry_meta: { id: 'v123', revision: 7 },
      vn_titles: [{ id: 'v123', lang: 'en', official: true, title: 'Authored classification fixture', latin: null }],
      vn_extlinks: [],
      extlinks: [],
    },
  };
}

function resultFor(request: BatchWriteRequest, subjectId: string): BatchWriteResult {
  return {
    results: request.commands.map((command) => {
      if (command.op === 'create') return { key: command.key, status: 201, value: { id: subjectId, revision: 1 } };
      if (command.op === 'propose')
        return { key: command.key, status: 201, value: { candidate: randomUUID(), revision: 1 } };
      return { key: command.key, status: 200, value: { revision: 1 } };
    }),
  };
}

async function associationForFixture() {
  const targetId = await fixture.createSubject({ type: 'skos:Concept', labels: { en: 'Authored classification target' } });
  const subjectId = await fixture.createSubject({
    type: 'schema:Book',
    labels: { en: 'Authored classification subject' },
    statements: {
      'schema:keywords': [
        {
          property: { id: 'schema:keywords' },
          value: { type: 'value', content: targetId },
          qualifiers: [],
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:url' },
                  value: { type: 'value', content: 'https://example.test/authored-classification' },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const response = await fixture.request('GET', `/v1/subjects/${subjectId}`);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { subject: { statements: Record<string, Statement[]> } };
  const statement = body.subject.statements['schema:keywords']![0]!;
  return {
    subjectId,
    targetId,
    candidateId: statement.id,
    property: 'schema:keywords',
    contextId: GLOBAL_CONTEXT,
    revision: statement.rezics.revision,
    release: bundledDigest,
    qualifiersDigest: classificationQualifiersDigest(statement.qualifiers),
  };
}

test('admitted classification uses the mounted client, retains provenance separately from ballots and resolves CAS', async () => {
  const association = await associationForFixture();
  const temporaryRoot = resolve(import.meta.dir, '../../../../.temp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'classification-import-'));
  const ballotCounts = async () => {
    const votes = await fixture.database.admin.query('SELECT count(*)::text AS n FROM rating.vote');
    const ballots = await fixture.database.admin.query('SELECT count(*)::text AS n FROM rating.classification_ballot_actor');
    return [votes[0]?.n, ballots[0]?.n];
  };
  const ballotsBefore = await ballotCounts();
  let loseNextPutResponse = false;
  const putRequests: { body: string; key: string | null }[] = [];
  let facts: Record<string, unknown> = {
    sourceAlias: 'trusted-fixture',
    sourceRecordId: 'v123',
    sourceRevision: '7',
    sourceAssociationId: 'g12',
    converterRevision: 'fixture@1',
    observedAt: '2026-11-03T00:00:00.000Z',
    coverage: { kind: 'unknown' },
    attribution: 'Authored integration fixture; not VNDB classification data',
    licence: { id: 'Fixture-1.0', url: 'https://example.test/licence' },
    value: { kind: 'observation', confidence: 2.4, lie: false },
  };
  const client = createImportTransport({
    origin: 'https://kernel.test',
    tokenProvider: async () => fixture.bearer,
    maxAttempts: 1,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith(':put'))
        putRequests.push({ body: await request.clone().text(), key: request.headers.get('idempotency-key') });
      const response = await fixture.app.handle(request);
      if (loseNextPutResponse && path.endsWith(':put')) {
        loseNextPutResponse = false;
        await response.body?.cancel();
        throw new TypeError('classification response lost after commit');
      }
      return response;
    }) as typeof fetch,
  });
  const transport: ImportTransport = {
    batchWrite: (request) => Promise.resolve(resultFor(request, association.subjectId)),
    readFence: async () => ({ fenced: false, securityRevision: null }),
    readSourceClassifications: client.readSourceClassifications,
    writeSourceClassification: client.writeSourceClassification,
    clearSourceClassification: client.clearSourceClassification,
  };
  const importer = new Importer({
    path: join(directory, 'state.sqlite'),
    transport,
    classificationAdmission: {
      facts: () => facts,
      association: () => association,
    },
  });
  const run = () =>
    importer.runRecords(
      createSourceRegistration('vndb'),
      (async function* () {
        yield vn();
      })(),
    );
  try {
    loseNextPutResponse = true;
    expect((await run()).status).toBe('bulk-failed');
    expect((await run()).status).toBe('committed');
    expect(putRequests).toHaveLength(2);
    expect(putRequests[1]).toEqual(putRequests[0]);
    expect(JSON.parse(putRequests[0]!.body)).toMatchObject({ expectedObservation: null });

    const read = await client.readSourceClassifications({ subjectId: association.subjectId, associations: [association] });
    expect(read[0]).toMatchObject({
      state: 'available',
      value: {
        association,
        sourceAlias: 'trusted-fixture',
        sourceRecordId: 'v123',
        sourceAssociationId: 'g12',
        attribution: 'Authored integration fixture; not VNDB classification data',
        licence: 'Fixture-1.0',
      },
    });

    facts = { ...facts, value: { kind: 'observation', confidence: 1.2, lie: false } };
    expect((await run()).status).toBe('observation-conflict');
    const pending = (await importer.pageClassificationConflicts('vndb')).operations[0]!;
    const original = importer.classificationDetail('vndb', pending.operationId)!.intended;
    const resolved = await importer.resolveClassification('vndb', pending.operationId, pending.reviewedHead!.digest);
    expect(resolved.status).toBe('delivered');
    expect(importer.classificationDetail('vndb', pending.operationId)!.intended).toEqual(original);
    const current = await client.readSourceClassifications({ subjectId: association.subjectId, associations: [association] });
    expect(current[0]).toMatchObject({
      state: 'available',
      value: { confidence: { state: 'available', value: 1.2 }, sourceRecordId: 'v123' },
    });
    expect(await ballotCounts()).toEqual(ballotsBefore);

    const digest = current[0]!.state === 'available' ? current[0].value.observation.digest : '';
    facts = {
      ...facts,
      value: { kind: 'observation', confidence: 2.8, lie: false },
      licence: { id: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
    };
    expect((await run()).status).toBe('committed');
    expect(putRequests).toHaveLength(3);
    expect(
      await client.readSourceClassifications({ subjectId: association.subjectId, associations: [association] }),
    ).toMatchObject([{ state: 'available', value: { observation: { digest } } }]);
    expect(await ballotCounts()).toEqual(ballotsBefore);
  } finally {
    await importer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
