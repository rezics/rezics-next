import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import { importShowcaseBooks } from '../../../importer/src/showcase-books.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;
type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  statement: {
    value: { content: unknown };
    rank?: 'normal' | 'preferred';
    qualifiers?: { property: { id: string }; value: { content: unknown } }[];
  };
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

function tables() {
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      if (provider !== 'bangumi') return;
      if (table === 'subject')
        yield* [
          series,
          volume,
          second,
          { id: 9001, type: 1, name: '文学少女', platform: 1002, series: false, infobox: '{{Infobox animanga/Novel}}' },
        ];
      if (table === 'subject-relations')
        yield* [
          { subject_id: 26, related_subject_id: 499, relation_type: 1002, order: 0 },
          { subject_id: 499, related_subject_id: 26, relation_type: 1003, order: 0 },
          { subject_id: 27, related_subject_id: 499, relation_type: 1002, order: 0 },
          { subject_id: 499, related_subject_id: 27, relation_type: 1003, order: 2 },
          { subject_id: 499, related_subject_id: 9002, relation_type: 1003, order: 9 },
        ];
      if (table === 'subject-persons') yield { person_id: 6023, subject_id: 499, position: 2001, appear_eps: '' };
      if (table === 'person') yield { id: 6023, name: '野村美月', type: 1, career: ['writer'] };
    },
  };
}

test('reader keeps book, volume and author identities after accept, adopt and one refresh', async () => {
  const previous = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = tmpdir();
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  })();
  const directory = await mkdtemp(join(tmpdir(), 'showcase-books-native-'));
  try {
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: randomUUID(), tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
    );
    expect(tier.status).toBe(200);
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
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
    const created = await runtime.importTransport.batch({
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
    expect(created.results.map((result) => result.status)).toEqual([201, 201]);
    const schemeId = (created.results[0] as { value: { id: string } }).value.id;
    const authorConcept = (created.results[1] as { value: { id: string } }).value.id;
    async function candidates(subjectId: string, property: string) {
      const page = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      return page.body as { candidates: Candidate[]; adoption: { head: number } | null };
    }
    async function acceptAdopt(subjectId: string, property: string) {
      const seen = new Set<string>();
      for (;;) {
        const listing = await candidates(subjectId, property);
        const next = listing.candidates.find((item) => item.source && !item.retracted && !seen.has(item.id));
        if (!next) {
          const live = listing.candidates.filter((item) => !item.retracted);
          if (!live.length) return listing;
          const adopted = await editor.http(`/v1/subjects/${subjectId}:adopt`, {
            context: globalContext,
            property,
            mode: 'replace',
            expected_head: listing.adoption?.head ?? null,
            selection: live.map((item) => ({ candidate: item.id, rank: item.statement.rank ?? 'normal' })),
          });
          expect(adopted.status).toBe(200);
          return listing;
        }
        const accepted = await editor.http(`/v1/subjects/${subjectId}/candidates/${next.id}:accept`, {
          context: globalContext,
          expected_head: next.head,
        });
        expect(accepted.status).toBe(200);
        seen.add(next.id);
      }
    }
    const bindings = {
      releaseDigest: bundledDigest,
      schemes: [
        {
          taxonomy: 'bangumi.staff',
          uri: 'https://rezics.com/schemes/bangumi/staff',
          id: schemeId,
          type: 'skos:ConceptScheme' as const,
          releaseDigest: bundledDigest,
        },
      ],
      concepts: [
        {
          taxonomy: 'bangumi.staff',
          code: '2001',
          id: authorConcept,
          type: 'skos:Concept' as const,
          schemeId,
          releaseDigest: bundledDigest,
        },
      ],
    };
    const first = await importShowcaseBooks({
      tables: tables(),
      path: join(directory, 'state.sqlite'),
      port: runtime.importTransport,
      destination: { origin: 'https://kernel.import.test' },
      bindings,
    });
    expect(first.selected.series).toEqual(['499']);
    expect(first.selected.volumes).toEqual(['26', '27']);
    expect(first.identities['499']?.type).toBe('schema:BookSeries');
    expect(first.identities['26']?.type).toBe('schema:Book');
    expect(first.gaps.some((gap) => gap.reason === 'Missing source volume for a stated series membership')).toBe(true);
    expect(JSON.stringify(first.selected)).not.toContain('9001');
    const seriesId = first.identities['499']!.id;
    const volumeId = first.identities['26']!.id;
    const authorId = first.identities['person:6023']!.id;
    for (const [id, property] of [
      [seriesId, 'schema:name'],
      [volumeId, 'schema:name'],
      [volumeId, 'wdt:P179'],
      [seriesId, 'schema:author'],
      [authorId, 'schema:name'],
    ] as const)
      await acceptAdopt(id, property);
    const book = await editor.http(`/v1/subjects/${volumeId}?context=${globalContext}`);
    expect(book.status).toBe(200);
    const bookView = book.body as {
      subject: { id: string; type: string; statements: Record<string, { value: { content: unknown } }[]> };
    };
    expect(bookView.subject.id).toBe(volumeId);
    expect(bookView.subject.type).toBe('schema:Book');
    expect(bookView.subject.statements['wdt:P179']?.map((row) => row.value.content)).toEqual([seriesId]);
    expect(JSON.stringify(bookView.subject.statements)).not.toContain('9784757728066');
    const seriesRead = await editor.http(`/v1/subjects/${seriesId}?context=${globalContext}`);
    expect(seriesRead.status).toBe(200);
    const seriesView = seriesRead.body as {
      subject: { id: string; type: string; statements: Record<string, { value: { content: unknown } }[]> };
    };
    expect(seriesView.subject.type).toBe('schema:BookSeries');
    expect(seriesView.subject.statements['schema:author']?.map((row) => row.value.content)).toEqual([authorId]);
    const refreshed = await importShowcaseBooks({
      tables: tables(),
      path: join(directory, 'state.sqlite'),
      port: runtime.importTransport,
      destination: { origin: 'https://kernel.import.test' },
      bindings,
    });
    expect(refreshed.identities['499']?.id).toBe(seriesId);
    expect(refreshed.identities['26']?.id).toBe(volumeId);
    expect(refreshed.identities['person:6023']?.id).toBe(authorId);
    const after = await editor.http(`/v1/subjects/${volumeId}?context=${globalContext}`);
    expect(after.status).toBe(200);
    expect((after.body as { subject: { id: string } }).subject.id).toBe(volumeId);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
