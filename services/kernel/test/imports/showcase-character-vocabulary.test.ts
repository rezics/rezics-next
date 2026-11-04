import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  appearanceRoleConceptUri,
  appearanceRoleSchemeUri,
  characterTraitConceptUri,
  characterTraitSchemeUri,
  importVndbCharacterTraits,
} from '../../../importer/src/vndb-character-traits.ts';
import {
  emptyCrossMediaPlan,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import {
  composeVndbCharacterVocabularyBindings,
  parseVndbCharacterVocabularyProfile,
  planShowcaseCharacterVocabulary,
} from '../../../importer/src/showcase-character-vocabulary.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const authored = {
  source: 'authored-showcase-vocabulary',
  converter_revision: 'authored@1',
  field_group: 'facts' as const,
};
const tableRows: Record<string, Record<string, unknown>[]> = {
  'vndb/vn': [{ id: 'v1', olang: 'ja', alias: null }],
  'vndb/vn_titles': [{ id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null }],
  'vndb/entry_meta': [{ id: 'v1', revision: '1', lastmod: '2026-11-01' }],
  'vndb/chars': [{ id: 'c1', name: 'Selected character', main: null }],
  'vndb/chars_traits': [
    { id: 'c1', tid: 'i73', spoil: '1', lie: 'f' },
    { id: 'c1', tid: 'i74', spoil: '0', lie: 'f' },
  ],
  'vndb/chars_vns': [{ id: 'c1', vid: 'v1', rid: null, role: 'main', spoil: '0' }],
  'vndb/traits': [
    { id: 'i73', name: 'Silver hair' },
    { id: 'i74', name: 'Unadmitted trait' },
  ],
  'vndb/traits_parents': [],
};
const tables: CrossMediaTables = {
  async *rows(provider, table) {
    yield* tableRows[`${provider}/${table}`] ?? [];
  },
};

test('selected character traits and appearances use current adopted vocabulary and retain identity on refresh', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'showcase-character-vocabulary-'));
  try {
    expect(
      (
        await runtime.request(
          `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
          { key: randomUUID(), tier: 'trusted' },
          identitySupport(runtime.identity).managementBearer,
        )
      ).status,
    ).toBe(200);
    const editor = await openApiObserver(runtime);
    expect(
      (
        await editor.http('/v1/grants', {
          resource: { route: 0, id: GLOBAL_CONTEXT },
          subject: { kind: 'account', id: runtime.identity.governance.accountId },
          actions: ['context:accept', 'context:adopt'],
          valid: '(,)',
        })
      ).status,
    ).toBe(201);
    const subjects = [
      ['trait-scheme', 'skos:ConceptScheme', 'VNDB traits'],
      ['other-scheme', 'skos:ConceptScheme', 'Other terms'],
      ['trait-i73', 'skos:Concept', 'Silver hair'],
      ['trait-i74', 'skos:Concept', 'Unadmitted trait'],
      ['role-scheme', 'skos:ConceptScheme', 'VNDB roles'],
      ['role-main', 'skos:Concept', 'Main'],
    ] as const;
    const digest = (id: string) => Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64);
    const create = await runtime.importTransport.batch({
      commands: subjects.map(([externalId, type, label]) => ({
        op: 'create' as const,
        key: `showcase-${externalId}`,
        source: { ...authored, external_id: externalId, record_revision: 'unversioned', digest: digest(externalId) },
        subject: { type, labels: { en: label } },
      })),
    });
    expect(create.results.every((result) => result.status === 201)).toBe(true);
    const ids = new Map(
      subjects.map(([externalId], index) => [
        externalId,
        (create.results[index] as { value: { id: string } }).value.id,
      ]),
    );
    const facts = [
      ['trait-scheme', 'schema:url', characterTraitSchemeUri, characterTraitSchemeUri],
      ['trait-i73', 'schema:url', characterTraitConceptUri('i73'), characterTraitConceptUri('i73')],
      ['trait-i73', 'skos:inScheme', ids.get('trait-scheme')!, characterTraitConceptUri('i73')],
      ['trait-i74', 'schema:url', characterTraitConceptUri('i74'), characterTraitConceptUri('i74')],
      ['trait-i74', 'skos:inScheme', ids.get('other-scheme')!, characterTraitConceptUri('i74')],
      ['role-scheme', 'schema:url', appearanceRoleSchemeUri, appearanceRoleSchemeUri],
      ['role-main', 'schema:url', appearanceRoleConceptUri('main'), appearanceRoleConceptUri('main')],
      ['role-main', 'skos:inScheme', ids.get('role-scheme')!, appearanceRoleConceptUri('main')],
    ] as const;
    const proposed = await runtime.importTransport.batch({
      commands: facts.map(([externalId, property, content, citation], index) => ({
        op: 'propose' as const,
        key: `showcase-${externalId}-${property}-${index}`,
        source: { ...authored, external_id: externalId, record_revision: 'unversioned', digest: digest(externalId) },
        subject: ids.get(externalId)!,
        statement: {
          property: { id: property },
          value: { type: 'value' as const, content },
          references: [
            { parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: citation } }] },
          ],
        },
      })),
    });
    expect(proposed.results.every((result) => result.status === 201)).toBe(true);
    for (const [externalId, property, content] of facts)
      await editor.adoptSubject(ids.get(externalId)!, property, content, GLOBAL_CONTEXT);

    const profile = parseVndbCharacterVocabularyProfile({
      traits: {
        schemeId: ids.get('trait-scheme'),
        concepts: [
          { code: 'i73', id: ids.get('trait-i73') },
          { code: 'i74', id: ids.get('trait-i74') },
        ],
      },
      roles: { schemeId: ids.get('role-scheme'), concepts: [{ code: 'main', id: ids.get('role-main') }] },
    });
    const selected = emptyCrossMediaPlan();
    selected.franchises['steins-gate'].vndb.push('v1');
    const requirements = await planShowcaseCharacterVocabulary(tables, selected);
    const bindings = await composeVndbCharacterVocabularyBindings(
      runtime.importTransport,
      profile,
      requirements.requirements,
    );
    expect(bindings.releaseDigest).toBe(bundledDigest);
    expect(bindings.concepts.map(({ code }) => code).sort()).toEqual(['i73', 'main']);

    const path = join(directory, 'state.sqlite');
    const imported = await importVndbCharacterTraits({
      tables,
      path,
      port: runtime.importTransport as CrossMediaPort,
      bindings,
      selectedWorkIds: requirements.requirements.selectedWorkIds,
      destination: { origin: 'https://kernel.import.test' },
    });
    const subjectId = (externalId: string) =>
      (imported.readings.find((item) => item.externalId === externalId)?.subject as { subject?: { id?: string } })
        .subject?.id;
    const heroineId = subjectId('c1')!;
    const workId = subjectId('v1')!;
    expect(heroineId && workId).toBeTruthy();
    await editor.adoptSubject(heroineId, 'schema:keywords', ids.get('trait-i73')!, GLOBAL_CONTEXT);
    await editor.adoptSubject(workId, 'schema:character', heroineId, GLOBAL_CONTEXT);
    const read = async (id: string) => {
      const response = await editor.http(`/v1/subjects/${id}?context=${GLOBAL_CONTEXT}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          type: string;
          statements: Record<string, { value: { content: unknown }; qualifiers?: unknown[]; references?: unknown[] }[]>;
        };
      };
    };
    const heroine = await read(heroineId);
    const trait = heroine.subject.statements['schema:keywords']?.[0];
    expect(heroine.subject.type).toBe('wd:Q95074');
    expect(trait?.value.content).toBe(ids.get('trait-i73'));
    expect(trait?.qualifiers).toContainEqual({
      property: { id: 'rezics:spoilerLevel' },
      value: { type: 'value', content: { amount: '+1', unit: '1' } },
    });
    expect(JSON.stringify(trait?.references)).toContain('/chars_traits/c1/i73');
    const work = await read(workId);
    const appearance = work.subject.statements['schema:character']?.[0];
    expect(work.subject.type).toBe('wd:Q689445');
    expect(appearance?.value.content).toBe(heroineId);
    expect(appearance?.qualifiers).toContainEqual({
      property: { id: 'wdt:P3831' },
      value: { type: 'value', content: ids.get('role-main') },
    });
    expect(JSON.stringify(appearance?.references)).toContain('/chars_vns/c1/v1');
    expect(JSON.stringify([heroine.subject.statements, work.subject.statements])).not.toContain(ids.get('trait-i74'));
    const refreshed = await importVndbCharacterTraits({
      tables: {
        async *rows(provider, table) {
          for (const row of tableRows[`${provider}/${table}`] ?? [])
            yield table === 'vndb/chars_traits' && row.tid === 'i73' ? { ...row, spoil: '2' } : row;
        },
      },
      path,
      port: runtime.importTransport as CrossMediaPort,
      bindings,
      selectedWorkIds: requirements.requirements.selectedWorkIds,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(subjectIdFrom(refreshed, 'c1')).toBe(heroineId);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

function subjectIdFrom(result: Awaited<ReturnType<typeof importVndbCharacterTraits>>, externalId: string) {
  return (result.readings.find((item) => item.externalId === externalId)?.subject as { subject?: { id?: string } })
    .subject?.id;
}
