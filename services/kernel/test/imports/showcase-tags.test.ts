import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand } from '@rezics/definitions/bulk';
import {
  commandKey,
  sourceDigest,
  sourceEnvelope,
  vndbPublicTagConceptUri,
  vndbPublicTagScheme,
} from '../../../../packages/conversion/src/support.ts';
import { parseAuthoredVndbCopy } from '../../../importer/src/vndb-public-tags.ts';
import { VNDB_PUBLIC_TAG_COLUMNS } from '../../../importer/src/vndb-tables.ts';
import { captureShowcaseCommands, ShowcaseJournal } from '../../../importer/src/showcase-publication.ts';
import { showcaseVocabularyExternalId } from '../../../importer/src/showcase-manifest.ts';
import {
  importShowcaseTags,
  knownShowcaseTagBindings,
  planShowcaseTags,
  prepareShowcaseVndbPublicTagVocabulary,
  readShowcaseVndbPublicTagVocabulary,
  showcaseTagWeightProperty,
} from '../../../importer/src/showcase-tags.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;
const tagsHeader = VNDB_PUBLIC_TAG_COLUMNS.tags.join('\t');
const associationHeader = VNDB_PUBLIC_TAG_COLUMNS.tags_vn.join('\t');
const parentHeader = VNDB_PUBLIC_TAG_COLUMNS.tags_parents.join('\t');
const tagsCopy = [
  'g311\tcont\t0\tt\tt\tAuthored content tag\t\\N\t\\N',
  'g44\tero\t2\tt\tt\tAuthored erotic tag\t\\N\t\\N',
  'g88\tcont\t0\tt\tt\tAuthored false tag\t\\N\t\\N',
];
const baseAssociations = [
  '2026-10-24\tg311\tv410\tu9001\t3\t0\tf\tf\tprivate note',
  '2026-10-24\tg44\tv410\tu9001\t2\t2\tf\tf\t\\N',
  '2026-10-24\tg88\tv410\tu9001\t-2\t0\tf\tt\tsecret lie',
];

function tables(associations = baseAssociations) {
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      if (provider !== 'vndb') return;
      if (table === 'vn') yield { id: 'v410', olang: 'en' };
      if (table === 'vn_titles')
        yield { id: 'v410', lang: 'en', official: 't', title: 'Selected public tag work', latin: null };
      if (table === 'entry_meta') yield { id: 'v410', revision: 7, lastmod: '2026-10-24' };
      if (table === 'tags') yield* parseAuthoredVndbCopy('tags', tagsHeader, tagsCopy);
      if (table === 'tags_vn') yield* parseAuthoredVndbCopy('tags_vn', associationHeader, associations);
      if (table === 'tags_parents') yield* parseAuthoredVndbCopy('tags_parents', parentHeader, ['g311\tg12\tt']);
    },
  };
}

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

test('reader sees selected VN source tag identity and spoiler; retracted or wrong-scheme bindings cannot restore it', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'showcase-tags-native-'));
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
      source: 'authored-showcase-tags',
      record_revision: 'unversioned',
      digest: 'a'.repeat(64),
      converter_revision: 'authored@1',
      field_group: 'facts' as const,
    };
    async function create(key: string, type: string, label: string) {
      const created = await runtime.importTransport.batch({
        commands: [
          {
            op: 'create',
            key,
            source: { ...authored, external_id: key },
            subject: { type, labels: { en: label } },
          },
        ],
      });
      expect(created.results[0]?.status).toBe(201);
      return (created.results[0] as { value: { id: string } }).value.id;
    }
    const contScheme = await create('scheme-cont', 'skos:ConceptScheme', 'Authored VNDB content tags');
    const eroScheme = await create('scheme-ero', 'skos:ConceptScheme', 'Authored VNDB erotic tags');
    const wrongScheme = await create('scheme-wrong', 'skos:ConceptScheme', 'Wrong scheme');
    const contId = await create('concept-g311', 'skos:Concept', 'Authored content tag');
    const eroId = await create('concept-g44', 'skos:Concept', 'Authored erotic tag');
    const wrongId = await create('concept-wrong', 'skos:Concept', 'Wrong scheme concept');
    const propose = await runtime.importTransport.batch({
      commands: [
        ...(['cont', 'ero'] as const).flatMap((category, index) => {
          const schemeId = [contScheme, eroScheme][index]!;
          const conceptId = [contId, eroId][index]!;
          const code = (['g311', 'g44'] as const)[index]!;
          const schemeUrl = vndbPublicTagScheme(category);
          const conceptUrl = vndbPublicTagConceptUri(category, code);
          const reference = (url: string) => [
            { parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: url } }] },
          ];
          return [
            {
              op: 'propose' as const,
              key: `scheme-url-${category}`,
              source: { ...authored, external_id: `scheme-${category}` },
              subject: schemeId,
              statement: {
                property: { id: 'schema:url' },
                value: { type: 'value' as const, content: schemeUrl },
                references: reference(schemeUrl),
              },
            },
            {
              op: 'propose' as const,
              key: `concept-url-${code}`,
              source: { ...authored, external_id: `concept-${code}` },
              subject: conceptId,
              statement: {
                property: { id: 'schema:url' },
                value: { type: 'value' as const, content: conceptUrl },
                references: reference(conceptUrl),
              },
            },
            {
              op: 'propose' as const,
              key: `concept-scheme-${code}`,
              source: { ...authored, external_id: `concept-${code}` },
              subject: conceptId,
              statement: {
                property: { id: 'skos:inScheme' },
                value: { type: 'value' as const, content: schemeId },
                references: reference(conceptUrl),
              },
            },
          ];
        }),
        {
          op: 'propose' as const,
          key: 'scheme-url-wrong',
          source: { ...authored, external_id: 'scheme-wrong' },
          subject: wrongScheme,
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value' as const, content: 'https://rezics.com/schemes/vndb/public-tags/other' },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value' as const, content: 'https://rezics.com/schemes/vndb/public-tags/other' },
                  },
                ],
              },
            ],
          },
        },
        {
          op: 'propose' as const,
          key: 'concept-url-wrong',
          source: { ...authored, external_id: 'concept-wrong' },
          subject: wrongId,
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value' as const, content: 'https://rezics.com/schemes/vndb/public-tags/other/g311' },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: {
                      type: 'value' as const,
                      content: 'https://rezics.com/schemes/vndb/public-tags/other/g311',
                    },
                  },
                ],
              },
            ],
          },
        },
        {
          op: 'propose' as const,
          key: 'concept-scheme-wrong',
          source: { ...authored, external_id: 'concept-wrong' },
          subject: wrongId,
          statement: {
            property: { id: 'skos:inScheme' },
            value: { type: 'value' as const, content: wrongScheme },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: {
                      type: 'value' as const,
                      content: 'https://rezics.com/schemes/vndb/public-tags/other/g311',
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(propose.results.every((result) => result.status === 201)).toBe(true);
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
    for (const [id, property] of [
      [contScheme, 'schema:url'],
      [eroScheme, 'schema:url'],
      [wrongScheme, 'schema:url'],
      [contId, 'schema:url'],
      [eroId, 'schema:url'],
      [wrongId, 'schema:url'],
      [contId, 'skos:inScheme'],
      [eroId, 'skos:inScheme'],
      [wrongId, 'skos:inScheme'],
    ] as const)
      await acceptAdopt(id, property);
    const known = {
      schemes: [
        { category: 'cont' as const, id: contScheme },
        { category: 'ero' as const, id: eroScheme },
      ],
      concepts: [
        { category: 'cont' as const, code: 'g311', id: contId },
        { category: 'ero' as const, code: 'g44', id: eroId },
      ],
    };
    const path = join(directory, 'state.sqlite');
    const first = await importShowcaseTags({
      tables: tables(),
      selectedVids: ['v410'],
      path,
      port: runtime.importTransport,
      known,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(first.bindings.releaseDigest).toBe(bundledDigest);
    expect(first.weightGap?.property).toBe(showcaseTagWeightProperty);
    const work = first.readings.find((row) => row.externalId === 'v410');
    expect(work).toBeTruthy();
    const workId = (work!.subject as { subject?: { id: string } }).subject?.id ?? (work!.subject as { id?: string }).id;
    expect(workId).toBeTruthy();
    await acceptAdopt(workId!, 'schema:genre');
    const read = await editor.http(`/v1/subjects/${workId}?context=${globalContext}`);
    expect(read.status).toBe(200);
    const current = read.body as {
      subject: {
        id: string;
        type: string;
        statements: Record<
          string,
          { value: { content: unknown }; qualifiers?: { property: { id: string }; value: { content: unknown } }[] }[]
        >;
      };
    };
    expect(current.subject.type).toBe('wd:Q689445');
    const genres = current.subject.statements['schema:genre'] ?? [];
    expect(genres.map((item) => item.value.content).sort()).toEqual([contId, eroId].sort());
    const spoilerOf = (id: string) =>
      genres
        .find((item) => item.value.content === id)
        ?.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel')?.value.content;
    expect(spoilerOf(contId)).toEqual({ amount: '+0', unit: '1' });
    expect(spoilerOf(eroId)).toEqual({ amount: '+2', unit: '1' });
    expect(JSON.stringify(current.subject.statements)).not.toContain(showcaseTagWeightProperty);
    expect(JSON.stringify(current.subject.statements)).not.toContain('u9001');
    const original = await candidates(workId!, 'schema:genre');
    const changed = [...baseAssociations];
    changed[0] = '2026-10-24\tg311\tv410\tu9001\t3\t1\tf\tf\tprivate note';
    const refreshed = await importShowcaseTags({
      tables: tables(changed),
      selectedVids: ['v410'],
      path,
      port: runtime.importTransport,
      known,
      destination: { origin: 'https://kernel.import.test' },
    });
    const refreshedWork =
      (refreshed.readings[0]?.subject as { subject?: { id: string } }).subject?.id ??
      (refreshed.readings[0]?.subject as { id?: string }).id;
    expect(refreshedWork).toBe(workId);
    await acceptAdopt(workId!, 'schema:genre');
    const afterChange = await candidates(workId!, 'schema:genre');
    expect(afterChange.candidates.map((item) => item.id).sort()).not.toEqual(
      original.candidates.map((item) => item.id).sort(),
    );
    const eroUrl = (await candidates(eroId, 'schema:url')).candidates.find((item) => item.source)!;
    const retracted = await editor.http(`/v1/statements/${eroUrl.id}/retract`, {});
    expect(retracted.status).toBe(200);
    const afterRetract = await importShowcaseTags({
      tables: tables(),
      selectedVids: ['v410'],
      path,
      port: runtime.importTransport,
      known,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(afterRetract.bindings.concepts.map((item) => item.id).sort()).toEqual([contId]);
    const wrong = await importShowcaseTags({
      tables: tables(),
      selectedVids: ['v410'],
      path,
      port: runtime.importTransport,
      known: {
        schemes: [{ category: 'cont', id: wrongScheme }],
        concepts: [{ category: 'cont', code: 'g311', id: wrongId }],
      },
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(wrong.bindings.concepts).toEqual([]);
    const restored = await candidates(workId!, 'schema:genre');
    expect(restored.candidates.filter((item) => !item.retracted && item.statement.value.content === wrongId)).toEqual(
      [],
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

const adapterRevision = 'vndb-public-tag-vocabulary@1';
const dictionaryCopy = [
  'g311\tcont\t0\tt\tt\t学園\t\\N\t\\N',
  'g44\tero\t2\tt\tt\tAuthored erotic tag\t\\N\t\\N',
  'g12\tcont\t0\tt\tt\t親タグ\t\\N\t\\N',
  'g88\tcont\t0\tt\tt\tAuthored false tag\t\\N\t\\N',
];

function dictionaryTables() {
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      if (provider !== 'vndb') return;
      if (table === 'vn') yield { id: 'v410', olang: 'en' };
      if (table === 'vn_titles')
        yield { id: 'v410', lang: 'en', official: 't', title: 'Selected public tag work', latin: null };
      if (table === 'entry_meta') yield { id: 'v410', revision: 7, lastmod: '2026-10-24' };
      if (table === 'tags') yield* parseAuthoredVndbCopy('tags', tagsHeader, dictionaryCopy);
      if (table === 'tags_vn') yield* parseAuthoredVndbCopy('tags_vn', associationHeader, baseAssociations);
      if (table === 'tags_parents') yield* parseAuthoredVndbCopy('tags_parents', parentHeader, ['g311\tg12\tt']);
    },
  };
}

function guessedTagCreate(input: {
  sourceKey: string;
  uri: string;
  citation: string;
  labels: Record<string, string>;
}): Extract<BatchCommand, { op: 'create' }> {
  const source = sourceEnvelope(
    {
      source: 'vndb_cross_media',
      external_id: showcaseVocabularyExternalId(input.sourceKey),
      record_revision: null,
      converter_revision: adapterRevision,
      digest: sourceDigest({
        sourceKey: input.sourceKey,
        uri: input.uri,
        citations: [input.uri, input.citation],
        adapterRevision,
      }),
    },
    'facts',
  );
  return {
    op: 'create',
    key: `vndb-public-tag-vocabulary:${commandKey([JSON.stringify(source), 'create', 'skos:Concept', JSON.stringify(input.labels)])}`,
    source,
    subject: { type: 'skos:Concept', labels: input.labels },
  };
}

async function acceptAdopted(
  editor: Awaited<ReturnType<typeof openApiObserver>>,
  subjectId: string,
  property: string,
) {
  const seen = new Set<string>();
  for (;;) {
    const page = await editor.http(
      `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
    );
    expect(page.status).toBe(200);
    const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
    const next = listing.candidates.find((item) => item.source && !item.retracted && !seen.has(item.id));
    if (!next) {
      const live = listing.candidates.filter((item) => !item.retracted);
      if (!live.length) return;
      const adopted = await editor.http(`/v1/subjects/${subjectId}:adopt`, {
        context: globalContext,
        property,
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: live.map((item) => ({ candidate: item.id, rank: item.statement.rank ?? 'normal' })),
      });
      expect(adopted.status).toBe(200);
      return;
    }
    const accepted = await editor.http(`/v1/subjects/${subjectId}/candidates/${next.id}:accept`, {
      context: globalContext,
      expected_head: next.head,
    });
    expect(accepted.status).toBe(200);
    seen.add(next.id);
  }
}

test('default selected VN tag publication keeps language-less names as und through native create, review and public read', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'showcase-tags-und-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
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
    const port = captureShowcaseCommands(runtime.importTransport, journal);
    const tables = dictionaryTables();
    const plan = await planShowcaseTags({ tables, selectedVids: ['v410'] });
    await prepareShowcaseVndbPublicTagVocabulary({ tables, selectedVids: ['v410'], plan, port, journal, stage: 'schemes' });
    await prepareShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
      stage: 'concepts',
    });
    const created = new Map(
      journal.acknowledgedCommands().flatMap((ack) =>
        ack.command.op === 'create' && ack.subjectId ? [[ack.command.source.external_id, ack.subjectId] as const] : [],
      ),
    );
    const hanId = created.get('vocabulary:vndb.tag.cont:g311')!;
    const kanaId = created.get('vocabulary:vndb.tag.cont:g12')!;
    const latinId = created.get('vocabulary:vndb.tag.ero:g44')!;
    const labelsOf = async (id: string) => {
      const read = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(read.status).toBe(200);
      return (read.body as { subject: { labels?: Record<string, string> } }).subject.labels;
    };
    expect(await labelsOf(hanId)).toEqual({ und: '学園' });
    expect(await labelsOf(kanaId)).toEqual({ und: '親タグ' });
    expect(await labelsOf(latinId)).toEqual({ und: 'Authored erotic tag' });
    for (const [id, property] of [
      [created.get('vocabulary:vndb.tag.cont')!, 'schema:url'],
      [created.get('vocabulary:vndb.tag.ero')!, 'schema:url'],
      [hanId, 'schema:url'],
      [kanaId, 'schema:url'],
      [latinId, 'schema:url'],
      [hanId, 'skos:inScheme'],
      [kanaId, 'skos:inScheme'],
      [latinId, 'skos:inScheme'],
    ] as const)
      await acceptAdopted(editor, id, property);
    const current = await readShowcaseVndbPublicTagVocabulary({ tables, selectedVids: ['v410'], plan, port, journal });
    expect(current.concepts.find((item) => item.code === 'g311')?.id).toBe(hanId);
    const imported = await importShowcaseTags({
      tables,
      selectedVids: ['v410'],
      path: join(directory, 'state.sqlite'),
      port,
      known: knownShowcaseTagBindings(current),
      destination: { origin: 'https://kernel.import.test' },
    });
    const workId =
      (imported.readings[0]?.subject as { subject?: { id: string } }).subject?.id ??
      (imported.readings[0]?.subject as { id?: string }).id;
    expect(workId).toBeTruthy();
    await acceptAdopted(editor, workId!, 'schema:genre');
    expect(await labelsOf(hanId)).toEqual({ und: '学園' });
    expect(await labelsOf(kanaId)).toEqual({ und: '親タグ' });
    expect(await labelsOf(latinId)).toEqual({ und: 'Authored erotic tag' });
    const publicWork = await editor.http(`/v1/subjects/${workId}?context=${globalContext}`);
    expect(publicWork.status).toBe(200);
    const genres = (
      publicWork.body as {
        subject: {
          statements: Record<
            string,
            { value: { content: unknown }; qualifiers?: { property: { id: string }; value: { content: unknown } }[] }[]
          >;
        };
      }
    ).subject.statements['schema:genre'];
    expect(genres?.map((item) => item.value.content).sort()).toEqual([hanId, latinId].sort());
    const spoilerOf = (id: string) =>
      genres
        ?.find((item) => item.value.content === id)
        ?.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel')?.value.content;
    expect(spoilerOf(hanId)).toEqual({ amount: '+0', unit: '1' });
    expect(spoilerOf(latinId)).toEqual({ amount: '+2', unit: '1' });
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

test('reopening a pre-repair journal recovers sealed tag creates and original Concept identities', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'showcase-tags-reopen-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
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
    const kana = guessedTagCreate({
      sourceKey: 'vndb.tag.cont:g12',
      uri: vndbPublicTagConceptUri('cont', 'g12'),
      citation: 'https://vndb.org/g12',
      labels: { ja: '親タグ' },
    });
    const han = guessedTagCreate({
      sourceKey: 'vndb.tag.cont:g311',
      uri: vndbPublicTagConceptUri('cont', 'g311'),
      citation: 'https://vndb.org/g311',
      labels: { 'zh-Hant': '学園' },
    });
    journal.prepareCommand(kana);
    const sealed = await runtime.importTransport.batch({ commands: [kana] });
    expect(sealed.results[0]?.status).toBe(201);
    journal.acknowledgeCommand(kana, sealed.results[0] as Extract<(typeof sealed.results)[number], { status: 200 | 201 }>);
    const sealedKanaId = (sealed.results[0] as { value: { id: string } }).value.id;
    journal.prepareCommand(han);
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const sent: BatchCommand[] = [];
    const captured = captureShowcaseCommands(runtime.importTransport, journal);
    const port = {
      ...captured,
      async batch(request: { commands: BatchCommand[] }) {
        sent.push(...request.commands);
        return captured.batch(request);
      },
    };
    const tables = dictionaryTables();
    const plan = await planShowcaseTags({ tables, selectedVids: ['v410'] });
    await prepareShowcaseVndbPublicTagVocabulary({ tables, selectedVids: ['v410'], plan, port, journal, stage: 'schemes' });
    await prepareShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
      stage: 'concepts',
    });
    const creates = sent.filter(
      (command): command is Extract<BatchCommand, { op: 'create' }> =>
        command.op === 'create' && command.subject.type === 'skos:Concept',
    );
    expect(creates.filter((command) => command.source.external_id === kana.source.external_id)).toEqual([]);
    const recoveredHan = creates.find((command) => command.source.external_id === han.source.external_id);
    expect(recoveredHan?.key).toBe(han.key);
    expect(recoveredHan?.subject.labels).toEqual({ 'zh-Hant': '学園' });
    expect(creates.filter((command) => command.source.external_id === han.source.external_id)).toHaveLength(1);
    expect(creates.find((command) => command.source.external_id === 'vocabulary:vndb.tag.ero:g44')?.subject.labels).toEqual(
      { und: 'Authored erotic tag' },
    );
    const created = new Map(
      journal.acknowledgedCommands().flatMap((ack) =>
        ack.command.op === 'create' && ack.subjectId ? [[ack.command.source.external_id, ack.subjectId] as const] : [],
      ),
    );
    expect(created.get(kana.source.external_id)).toBe(sealedKanaId);
    const kanaRead = await editor.http(`/v1/subjects/${sealedKanaId}?context=${globalContext}`);
    expect(kanaRead.status).toBe(200);
    expect((kanaRead.body as { subject: { labels?: Record<string, string> } }).subject.labels).toEqual({ ja: '親タグ' });
    const hanId = created.get(han.source.external_id)!;
    const latinId = created.get('vocabulary:vndb.tag.ero:g44')!;
    for (const [id, property] of [
      [created.get('vocabulary:vndb.tag.cont')!, 'schema:url'],
      [created.get('vocabulary:vndb.tag.ero')!, 'schema:url'],
      [hanId, 'schema:url'],
      [sealedKanaId, 'schema:url'],
      [latinId, 'schema:url'],
      [hanId, 'skos:inScheme'],
      [sealedKanaId, 'skos:inScheme'],
      [latinId, 'skos:inScheme'],
    ] as const)
      await acceptAdopted(editor, id, property);
    const current = await readShowcaseVndbPublicTagVocabulary({ tables, selectedVids: ['v410'], plan, port, journal });
    expect(current.concepts.find((item) => item.code === 'g12')?.id).toBe(sealedKanaId);
    const imported = await importShowcaseTags({
      tables,
      selectedVids: ['v410'],
      path: join(directory, 'state.sqlite'),
      port,
      known: knownShowcaseTagBindings(current),
      destination: { origin: 'https://kernel.import.test' },
    });
    const workId =
      (imported.readings[0]?.subject as { subject?: { id: string } }).subject?.id ??
      (imported.readings[0]?.subject as { id?: string }).id;
    expect(workId).toBeTruthy();
    await acceptAdopted(editor, workId!, 'schema:genre');
    const read = await editor.http(`/v1/subjects/${workId}?context=${globalContext}`);
    expect(read.status).toBe(200);
    const genres = (
      read.body as {
        subject: {
          statements: Record<
            string,
            { value: { content: unknown }; qualifiers?: { property: { id: string }; value: { content: unknown } }[] }[]
          >;
        };
      }
    ).subject.statements['schema:genre'];
    expect(genres?.map((item) => item.value.content).sort()).toEqual([hanId, latinId].sort());
    const spoilerOf = (id: string) =>
      genres
        ?.find((item) => item.value.content === id)
        ?.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel')?.value.content;
    expect(spoilerOf(hanId)).toEqual({ amount: '+0', unit: '1' });
    expect(spoilerOf(latinId)).toEqual({ amount: '+2', unit: '1' });
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
