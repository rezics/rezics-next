import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import { vndbPublicTagConceptUri, vndbPublicTagScheme } from '../../../../packages/conversion/src/support.ts';
import { crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import {
  importVndbPublicTags,
  parseAuthoredVndbCopy,
  readVndbPublicTagBindings,
} from '../../../importer/src/vndb-public-tags.ts';
import { VNDB_PUBLIC_TAG_COLUMNS } from '../../../importer/src/vndb-tables.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;
const tagsHeader = VNDB_PUBLIC_TAG_COLUMNS.tags.join('\t');
const associationHeader = VNDB_PUBLIC_TAG_COLUMNS.tags_vn.join('\t');
const tagsCopy = [
  'g311\tcont\t0\tt\tt\tAuthored content tag\t\\N\t\\N',
  'g44\tero\t2\tt\tt\tAuthored erotic tag\t\\N\t\\N',
  'g7\ttech\t0\tt\tt\tAuthored technical tag\t\\N\t\\N',
  'g88\tcont\t0\tt\tt\tAuthored false tag\t\\N\t\\N',
  'g99\tcont\t1\tt\tt\tAuthored confidence tag\t\\N\t\\N',
];
const baseAssociations = [
  '2026-10-24\tg311\tv410\tu9001\t3\t0\tf\tf\tprivate note',
  '2026-10-24\tg311\tv410\tu9002\t2\t1\tf\tf\tprivate aggregate',
  '2026-10-24\tg44\tv410\tu9001\t2\t2\tf\tf\t\\N',
  '2026-10-24\tg7\tv410\tu9001\t1\t\\N\tf\tf\t\\N',
  '2026-10-24\tg9999\tv410\tu9001\t3\t0\tf\tf\t\\N',
  '2026-10-24\tg88\tv410\tu9001\t-2\t0\tf\tt\tsecret lie',
  '2026-10-24\tg99\tv410\tu9001\t2.4\t1\tf\tf\t\\N',
];

function tables(associations = baseAssociations, title = 'Authored public tag work') {
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      if (provider !== 'vndb') return;
      if (table === 'vn') yield { id: 'v410', olang: 'en' };
      if (table === 'vn_titles') yield { id: 'v410', lang: 'en', official: 't', title, latin: null };
      if (table === 'entry_meta') yield { id: 'v410', revision: 7, lastmod: '2026-10-24' };
      if (table === 'tags') yield* parseAuthoredVndbCopy('tags', tagsHeader, tagsCopy);
      if (table === 'tags_vn') yield* parseAuthoredVndbCopy('tags_vn', associationHeader, associations);
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

test('production operator publishes authored VNDB public tags through ordinary accept and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-public-tags-native-'));
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
    const ballotsBefore = await runtime.database.admin.query('SELECT count(*)::text AS n FROM rating.vote');
    const authored = {
      source: 'authored-vndb-public-tags',
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
    const techScheme = await create('scheme-tech', 'skos:ConceptScheme', 'Authored VNDB technical tags');
    const contId = await create('concept-g311', 'skos:Concept', 'Authored content tag');
    const eroId = await create('concept-g44', 'skos:Concept', 'Authored erotic tag');
    const techId = await create('concept-g7', 'skos:Concept', 'Authored technical tag');
    const propose = await runtime.importTransport.batch({
      commands: [
        ...(['cont', 'ero', 'tech'] as const).flatMap((category, index) => {
          const schemeId = [contScheme, eroScheme, techScheme][index]!;
          const conceptId = [contId, eroId, techId][index]!;
          const code = (['g311', 'g44', 'g7'] as const)[index]!;
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
      [techScheme, 'schema:url'],
      [contId, 'schema:url'],
      [eroId, 'schema:url'],
      [techId, 'schema:url'],
      [contId, 'skos:inScheme'],
      [eroId, 'skos:inScheme'],
      [techId, 'skos:inScheme'],
    ] as const)
      await acceptAdopt(id, property);
    const known = {
      schemes: [
        { category: 'cont' as const, id: contScheme },
        { category: 'ero' as const, id: eroScheme },
        { category: 'tech' as const, id: techScheme },
      ],
      concepts: [
        { category: 'cont' as const, code: 'g311', id: contId },
        { category: 'ero' as const, code: 'g44', id: eroId },
        { category: 'tech' as const, code: 'g7', id: techId },
      ],
    };
    const bindings = await readVndbPublicTagBindings(runtime.importTransport, known);
    expect(bindings.releaseDigest).toBe(bundledDigest);
    expect(bindings.concepts.map((item) => item.id).sort()).toEqual([contId, eroId, techId].sort());
    const path = join(directory, 'state.sqlite');
    const first = await importVndbPublicTags({
      tables: tables(),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const work = first.readings.find((row) => row.externalId === 'v410');
    expect(work).toBeTruthy();
    const workId = (work!.subject as { subject?: { id: string } }).subject?.id ?? (work!.subject as { id?: string }).id;
    expect(workId).toBeTruthy();
    await acceptAdopt(workId!, 'schema:genre');
    const read = await editor.http(`/v1/subjects/${workId}?context=${globalContext}`);
    expect(read.status).toBe(200);
    const current = read.body as {
      subject: {
        type: string;
        statements: Record<
          string,
          { value: { content: unknown }; qualifiers?: { property: { id: string }; value: { content: unknown } }[] }[]
        >;
      };
    };
    expect(current.subject.type).toBe('wd:Q689445');
    const genres = current.subject.statements['schema:genre'] ?? [];
    expect(genres.map((item) => item.value.content).sort()).toEqual([contId, eroId, techId].sort());
    const spoilerOf = (id: string) =>
      genres
        .find((item) => item.value.content === id)
        ?.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel')?.value.content;
    expect(spoilerOf(contId)).toEqual({ amount: '+0', unit: '1' });
    expect(spoilerOf(eroId)).toEqual({ amount: '+2', unit: '1' });
    expect(spoilerOf(techId)).toEqual({ amount: '+0', unit: '1' });
    expect(JSON.stringify(current.subject.statements)).not.toContain('vndb-tag-rating');
    expect(JSON.stringify(current.subject.statements)).not.toContain('u9001');
    const ballotsAfter = await runtime.database.admin.query('SELECT count(*)::text AS n FROM rating.vote');
    expect(ballotsAfter.rows[0]?.n).toBe(ballotsBefore.rows[0]?.n);
    const original = await candidates(workId!, 'schema:genre');
    const originalKeys = original.candidates.map((item) => item.id).sort();
    const again = await importVndbPublicTags({
      tables: tables(),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(again.readings.map((row) => row.externalId)).toEqual(['v410']);
    const unchanged = await candidates(workId!, 'schema:genre');
    expect(unchanged.candidates.map((item) => item.id).sort()).toEqual(originalKeys);
    const changed = [...baseAssociations];
    changed[0] = '2026-10-24\tg311\tv410\tu9001\t3\t1\tf\tf\tprivate note';
    await importVndbPublicTags({
      tables: tables(changed),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const afterChange = await candidates(workId!, 'schema:genre');
    expect(afterChange.candidates.map((item) => item.id).sort()).not.toEqual(originalKeys);
    expect(originalKeys.every((id) => afterChange.candidates.some((item) => item.id === id))).toBe(true);
    const eroUrl = (await candidates(eroId, 'schema:url')).candidates.find((item) => item.source)!;
    const retracted = await editor.http(`/v1/statements/${eroUrl.id}/retract`, {});
    expect(retracted.status).toBe(200);
    const withheld = await readVndbPublicTagBindings(runtime.importTransport, known);
    expect(withheld.concepts.map((item) => item.id).sort()).toEqual([contId, techId].sort());
    await importVndbPublicTags({
      tables: tables(),
      path,
      port: runtime.importTransport,
      bindings: withheld,
      destination: { origin: 'https://kernel.import.test' },
    });
    const afterRetract = await candidates(workId!, 'schema:genre');
    expect(
      afterRetract.candidates.filter((item) => !item.retracted && item.statement.value.content === eroId).length,
    ).toBeLessThanOrEqual(1);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'v410',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    await importVndbPublicTags({
      tables: tables(baseAssociations, 'Restored title after fence'),
      path,
      port: runtime.importTransport,
      bindings: withheld,
      destination: { origin: 'https://kernel.import.test' },
    });
    const names = (await candidates(workId!, 'schema:name')).candidates.map((item) => item.statement.value.content);
    expect(names).not.toContain('Restored title after fence');
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
