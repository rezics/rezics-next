import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { convertBangumi, converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import { convertCrossMediaEntity } from '../../../../packages/conversion/src/cross-media-entities.ts';
import { mapBangumiVocabulary } from '../../../../packages/conversion/src/bangumi-vocabulary.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import type { Dump } from '../../../../specs/imports-api-driver.ts';
import type { Subject } from '../../../../specs/semantic-driver.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  statement: { value: { content: unknown }; rank?: 'normal' | 'preferred' };
  source?: unknown;
};

const series = {
  id: 499,
  type: 1,
  name: '文学少女',
  name_cn: '文学少女',
  platform: 1002,
  series: true,
  date: '2006-04-28',
  infobox: '{{Infobox animanga/Novel\r\n|作者= 野村美月\r\n|册数= 8+8(番外)\r\n}}',
};
const volume = {
  id: 26,
  type: 1,
  name: '“文学少女”と死にたがりの道化',
  name_cn: '“文学少女”与渴望死亡的小丑',
  platform: 1002,
  series: false,
  date: '2006-04-28',
  infobox: '{{Infobox animanga/Novel\r\n|ISBN= 9784757728066\r\n|出版社= エンターブレイン\r\n|页数= 254\r\n}}',
};
const second = {
  id: 27,
  type: 1,
  name: '“文学少女”と飢え渇く幽霊',
  platform: 1002,
  series: false,
  date: '2006-08-30',
  infobox: '{{Infobox animanga/Novel\r\n|ISBN= 9784757729155\r\n}}',
};
const author = { id: 6023, name: '野村美月', type: 1, career: ['writer'] };
const rows = [series, volume, second];
const dump = (): Dump => ({
  source: 'bangumi',
  snapshot: 'label-only-not-a-source-revision',
  converterRevision: converter_revision,
  bytes: new TextEncoder().encode(rows.map((row) => JSON.stringify(row)).join('\n') + '\n'),
});

let runtime: ApiRuntime;
let observer: Awaited<ReturnType<typeof openApiObserver>>;
let initial: Awaited<ReturnType<ApiRuntime['run']>>;

beforeAll(async () => {
  runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  observer = await openApiObserver(runtime);
  initial = await runtime.run(dump());
}, 600_000);

afterAll(async () => {
  await runtime?.close();
}, 600_000);

function binding(id: string) {
  const claim = runtime.importer.session.bindings.claim({ source: 'bangumi', external_id: id });
  return claim?.state === 'bound' ? claim.subject : null;
}

test('reader keeps book, volume and author identities after accept, adopt and one refresh', async () => {
  expect(createSourceRegistration('bangumi').converter_revision).toBe(converter_revision);
  expect(initial.outcome).toBe('complete');
  expect(convertBangumi({ external_id: '499', record_revision: null, record: series }).proposals[0]).toMatchObject({
    subject: { type: 'schema:BookSeries' },
  });
  expect(
    convertBangumi({ external_id: '26', record_revision: null, record: volume }).diagnostics,
  ).toContainEqual({ pointer: '/infobox/ISBN', code: 'edition_assertion_withheld_on_work' });
  expect(binding('499')).toBeString();
  expect(binding('26')).toBeString();
  expect(binding('27')).toBeString();
  expect(binding('9001')).toBeNull();
  expect(binding('9002')).toBeNull();
  const seriesView = (await observer.http(`/v1/subjects/${binding('499')}`)).body.subject as Subject & {
    sourceRecords?: { source: string; external_id: string }[];
  };
  const volumeView = (await observer.http(`/v1/subjects/${binding('26')}`)).body.subject as Subject & {
    sourceRecords?: { source: string; external_id: string }[];
  };
  expect(seriesView.type).toBe('schema:BookSeries');
  expect(volumeView.type).toBe('schema:Book');
  expect(JSON.stringify(volumeView.statements)).not.toContain('9784757728066');
  expect(bundledRelease.types['schema:BookSeries']).toBeDefined();
  expect(bundledRelease.types['schema:Book']).toBeDefined();
  expect(seriesView.sourceRecords?.some((row) => row.source === 'bangumi' && row.external_id === '499')).toBe(true);

  const person = convertCrossMediaEntity(
    { external_id: 'person:6023', record_revision: null, record: author },
    { source: 'bangumi' },
    { sourceKind: 'bangumi' },
  );
  expect(person.proposals[0]).toMatchObject({ subject: { type: 'schema:Person' } });
  const createdPerson = await runtime.importTransport.batch({ commands: [...person.proposals] });
  expect(createdPerson.results[0]?.status).toBe(201);
  const personId =
    createdPerson.results[0] && 'value' in createdPerson.results[0]
      ? (createdPerson.results[0].value as { id: string }).id
      : binding('person:6023');
  expect(personId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

  const grant = await observer.http('/v1/grants', {
    resource: { route: 0, id: globalContext },
    subject: { kind: 'account', id: runtime.identity.governance.accountId },
    actions: ['context:accept', 'context:adopt'],
    valid: '(,)',
  });
  expect(grant.status).toBe(201);
  const authored = {
    source: 'authored-showcase-books',
    record_revision: 'unversioned',
    digest: 'a'.repeat(64),
    converter_revision: 'authored@1',
    field_group: 'facts' as const,
  };
  const vocabulary = await runtime.importTransport.batch({
    commands: [
      {
        op: 'create',
        key: 'scheme-staff',
        source: { ...authored, external_id: 'scheme-staff' },
        subject: { type: 'skos:ConceptScheme', labels: { en: 'Bangumi staff' } },
      },
      {
        op: 'create',
        key: 'concept-2001',
        source: { ...authored, external_id: 'concept-2001' },
        subject: { type: 'skos:Concept', labels: { en: 'Author' } },
      },
    ],
  });
  expect(vocabulary.results.map((result) => result.status)).toEqual([201, 201]);
  const schemeId = (vocabulary.results[0] as { value: { id: string } }).value.id;
  const authorConcept = (vocabulary.results[1] as { value: { id: string } }).value.id;
  const seriesId = binding('499')!;
  const volumeId = binding('26')!;
  const membership = mapBangumiVocabulary({
    metadata: {
      provider: 'bangumi',
      sourceAlias: 'bangumi',
      externalId: '26',
      recordRevision: null,
      digest: convertBangumi({ external_id: '26', record_revision: null, record: volume }).digest,
      converterRevision: converter_revision,
      recordUrl: 'https://bgm.tv/subject/26',
      license: 'CC-BY-SA-3.0',
      attribution: 'Bangumi contributors',
    },
    bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    rows: [
      {
        kind: 'relation',
        path: '/subject-relations/26/499',
        subject: { id: volumeId, type: 'schema:Book', releaseDigest: bundledDigest },
        endpoint: { id: seriesId, type: 'schema:BookSeries', releaseDigest: bundledDigest },
        endpointCode: '499',
        family: 1,
        code: 1002,
        reciprocalCode: 1003,
        order: 0,
      },
    ],
  });
  const credits = mapBangumiVocabulary({
    metadata: {
      provider: 'bangumi',
      sourceAlias: 'bangumi',
      externalId: '499',
      recordRevision: null,
      digest: convertBangumi({ external_id: '499', record_revision: null, record: series }).digest,
      converterRevision: converter_revision,
      recordUrl: 'https://bgm.tv/subject/499',
      license: 'CC-BY-SA-3.0',
      attribution: 'Bangumi contributors',
    },
    bindings: {
      releaseDigest: bundledDigest,
      schemes: [
        {
          taxonomy: 'bangumi.staff',
          uri: 'https://rezics.com/schemes/bangumi/staff',
          id: schemeId,
          type: 'skos:ConceptScheme',
          releaseDigest: bundledDigest,
        },
      ],
      concepts: [
        {
          taxonomy: 'bangumi.staff',
          code: '2001',
          id: authorConcept,
          type: 'skos:Concept',
          schemeId,
          releaseDigest: bundledDigest,
        },
      ],
    },
    rows: [
      {
        kind: 'staff',
        path: '/subject-persons/499/6023/position',
        subject: { id: seriesId, type: 'schema:BookSeries', releaseDigest: bundledDigest },
        holder: { id: personId!, type: 'schema:Person', releaseDigest: bundledDigest },
        holderCode: 'person:6023',
        subjectType: 1,
        roleCode: 2001,
      },
    ],
  });
  expect(membership.proposals).toHaveLength(1);
  const delivered = await runtime.importTransport.batch({
    commands: [...membership.proposals, ...credits.proposals],
  });
  expect(delivered.results.every((result) => result.status === 201 || result.status === 200)).toBe(true);

  async function adopt(subjectId: string, property: string, content: string) {
    const page = await observer.http(
      `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '20' })}`,
    );
    expect(page.status).toBe(200);
    const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
    const live = listing.candidates.filter((item) => !item.retracted && item.statement.value.content === content);
    expect(live).toHaveLength(1);
    expect(
      (
        await observer.http(`/v1/subjects/${subjectId}/candidates/${live[0]!.id}:accept`, {
          context: globalContext,
          expected_head: live[0]!.head,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await observer.http(`/v1/subjects/${subjectId}:adopt`, {
          context: globalContext,
          property,
          mode: 'replace',
          expected_head: listing.adoption?.head ?? null,
          selection: [{ candidate: live[0]!.id, rank: live[0]!.statement.rank ?? 'normal' }],
        })
      ).status,
    ).toBe(200);
  }
  await adopt(volumeId, 'wdt:P179', seriesId);
  if (credits.proposals.length) await adopt(seriesId, 'schema:author', personId!);
  const book = await observer.http(`/v1/subjects/${volumeId}?context=${globalContext}`);
  expect(book.status).toBe(200);
  const adopted = book.body.subject as Subject;
  expect(adopted.id).toBe(volumeId);
  expect(adopted.type).toBe('schema:Book');
  expect(adopted.statements['wdt:P179']?.map((row) => row.value.content)).toEqual([seriesId]);
  expect(JSON.stringify(adopted.statements)).not.toContain('9784757728066');
  const refreshed = await runtime.run(dump());
  expect(refreshed.outcome).toBe('complete');
  expect(binding('499')).toBe(seriesId);
  expect(binding('26')).toBe(volumeId);
  const personRead = await observer.http(`/v1/subjects/${personId}`);
  expect(personRead.status).toBe(200);
  expect((personRead.body.subject as Subject).type).toBe('schema:Person');
}, 600_000);
