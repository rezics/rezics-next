import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import type { CrossMediaPort } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import {
  creditTypeConceptUri,
  creditTypeSchemeUri,
  importVndbStaffCredits,
  planVndbStaffCredits,
  readCreditTypeBindings,
} from '../src/vndb-staff-credits.ts';

function authoredTables() {
  const rows: Record<string, Record<string, unknown>[]> = {
    'vndb/vn': [{ id: 'v1', olang: 'en', alias: null }],
    'vndb/vn_titles': [{ id: 'v1', lang: 'en', official: true, title: 'Authored visual novel', latin: null }],
    'vndb/entry_meta': [{ id: 'v1', revision: '7', lastmod: '2026-10-25 00:00:00+00' }],
    'vndb/vn_staff': [
      { id: 'v1', aid: '10', role: 'scenario', note: 'Writer Alias' },
      { id: 'v1', aid: '20', role: 'chardesign', note: 'Artist Alias' },
      { id: 'v1', aid: '30', role: 'unknown', note: 'Lost role' },
      { id: 'v1', aid: '40', role: 'scenario', note: 'Missing alias' },
      { id: 'v1', aid: '50', role: 'scenario', note: 'Studio' },
    ],
    'vndb/vn_seiyuu': [{ id: 'v1', aid: '10', cid: 'c3', note: 'Voice Alias' }],
    'vndb/staff_alias': [
      { id: 's4', aid: '10', name: 'Writer Alias' },
      { id: 's4', aid: '20', name: 'Artist Alias' },
      { id: 's4', aid: '30', name: 'Lost role' },
      { id: 'p9', aid: '50', name: 'Studio' },
    ],
    'vndb/staff': [{ id: 's4', main: '10', prod: null }],
    'vndb/chars': [{ id: 'c3', main: null, name: 'Authored character' }],
    'vndb/producers': [{ id: 'p9', name: 'Authored studio', type: 'co' }],
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

const schemeId = '00000000-0000-4000-8000-000000000090';
const scenarioId = '00000000-0000-4000-8000-000000000091';
const designId = '00000000-0000-4000-8000-000000000092';
const subjects: Record<string, object> = {
  [schemeId]: {
    subject: {
      id: schemeId,
      type: 'skos:ConceptScheme',
      statements: { 'schema:url': [{ value: { content: creditTypeSchemeUri } }] },
    },
  },
  [scenarioId]: {
    subject: {
      id: scenarioId,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: creditTypeConceptUri('scenario') } }],
        'skos:inScheme': [{ value: { content: schemeId } }],
      },
    },
  },
  [designId]: {
    subject: {
      id: designId,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: creditTypeConceptUri('chardesign') } }],
        'skos:inScheme': [{ value: { content: schemeId } }],
      },
    },
  },
};

function port(commands: BatchCommand[]): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? { id: randomUUID(), revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this authored fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      const known = subjects[id];
      if (!known) return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
      return known as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

test('operator plans two aliases for one person and imports exact roles through the seed caller', async () => {
  const plan = await planVndbStaffCredits(authoredTables());
  expect(plan.records.vndb.map((row) => row.key)).toEqual(['v1']);
  expect(plan.entities.vndb.map((row) => row.key).sort()).toEqual(['c3', 's4']);
  expect(plan.staffCredits.map((credit) => [credit.kind, credit.staffId, credit.role ?? credit.characterId])).toEqual([
    ['staff', 's4', 'scenario'],
    ['staff', 's4', 'chardesign'],
    ['staff', 's4', 'unknown'],
    ['voice', 's4', 'c3'],
  ]);
  expect(plan.gaps.some((gap) => gap.record.aid === '40')).toBe(true);
  expect(plan.gaps.some((gap) => gap.record.aid === '50' && gap.reason.includes('person identity'))).toBe(true);
  expect(plan.edges).toEqual([]);
  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'vndb-staff-credits-'));
  try {
    const bindings = await readCreditTypeBindings(port(commands), {
      schemeId,
      concepts: [
        { code: 'scenario', id: scenarioId },
        { code: 'chardesign', id: designId },
      ],
    });
    expect(bindings.releaseDigest).toBe(bundledDigest);
    expect(bindings.concepts.map((item) => item.code).sort()).toEqual(['chardesign', 'scenario']);
    const first = await importVndbStaffCredits({
      tables: authoredTables(),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    expect(first.converterRevision).toBe(converter_revision);
    const proposed = commands.filter((command) => command.op === 'propose');
    const content = (command: (typeof proposed)[number]) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    const qualifiers = (command: (typeof proposed)[number]) => command.statement.qualifiers ?? [];
    const author = proposed.find((command) => command.statement.property.id === 'schema:author')!;
    const art = proposed.find((command) => command.statement.property.id === 'schema:illustrator')!;
    const voice = proposed.find((command) => command.statement.property.id === 'wdt:P725')!;
    expect(content(author)).toBe(content(art));
    expect(content(voice)).toBe(content(author));
    expect(qualifiers(author)).toEqual(
      expect.arrayContaining([
        { property: { id: 'wdt:P3831' }, value: { type: 'value', content: scenarioId } },
        { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Writer Alias' } },
      ]),
    );
    expect(qualifiers(art)).toEqual(
      expect.arrayContaining([
        { property: { id: 'wdt:P3831' }, value: { type: 'value', content: designId } },
        { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Artist Alias' } },
      ]),
    );
    expect(qualifiers(voice)).toEqual(
      expect.arrayContaining([
        { property: { id: 'wdt:P453' }, value: { type: 'value', content: expect.any(String) } },
        { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Voice Alias' } },
      ]),
    );
    expect(proposed.some((command) => command.statement.property.id === 'schema:musicBy')).toBe(false);
    const keys = proposed.map((command) => command.key);
    const count = commands.length;
    const again = await importVndbStaffCredits({
      tables: authoredTables(),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    expect(commands.filter((command) => command.op === 'propose').map((command) => command.key)).toEqual(
      expect.arrayContaining(keys),
    );
    expect(commands.length).toBeGreaterThanOrEqual(count);
    subjects[scenarioId] = { subject: { id: scenarioId, type: 'skos:Concept', statements: {} } };
    const withheld = await readCreditTypeBindings(port([]), {
      schemeId,
      concepts: [
        { code: 'scenario', id: scenarioId },
        { code: 'chardesign', id: designId },
      ],
    });
    expect(withheld.concepts.map((item) => item.code)).toEqual(['chardesign']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
