import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceVocabularyBindings } from '@rezics/conversion/source-vocabulary';
import {
  appearanceRoleTaxonomy,
  appearanceRoleConceptUri,
  appearanceRoleSchemeUri,
  characterTraitConceptUri,
  characterTraitSchemeUri,
  importVndbCharacterTraits,
} from '../../../importer/src/vndb-character-traits.ts';
import {
  planCrossMediaSeed,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import {
  composeVndbCharacterVocabularyBindings,
  planShowcaseCharacterVocabulary,
  prepareShowcaseCharacterVocabulary,
  profileFromCharacterVocabularyBindings,
  readShowcaseCharacterVocabulary,
} from '../../../importer/src/showcase-character-vocabulary.ts';
import { prepareShowcaseVndbTraits } from '../../../importer/src/showcase-vndb-traits.ts';
import { captureShowcaseCommands, ShowcaseJournal } from '../../../importer/src/showcase-publication.ts';
import { showcaseVocabularyExternalId } from '../../../importer/src/showcase-manifest.ts';
import { developmentShowcaseSelection } from '../../../../scripts/datasets/cross-media-seed.ts';
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
  'bangumi/subject': [
    { id: 10380, type: 2, name: 'STEINS;GATE' },
    { id: 84148, type: 1, name: 'STEINS;GATE Official Book' },
    { id: 51, type: 2, name: 'CLANNAD' },
  ],
  'vndb/vn': [
    { id: 'v2002', olang: 'ja', alias: null },
    { id: 'v4', olang: 'ja', alias: null },
  ],
  'vndb/vn_titles': [
    { id: 'v2002', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
    { id: 'v4', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
  ],
  'vndb/entry_meta': [
    { id: 'v2002', revision: '1', lastmod: '2026-11-01' },
    { id: 'v4', revision: '1', lastmod: '2026-11-01' },
  ],
  'vndb/chars': [{ id: 'c6487', name: 'Selected heroine', main: null }],
  'vndb/chars_traits': [
    { id: 'c6487', tid: 'i23', spoil: '1', lie: 'f' },
    { id: 'c6487', tid: 'i99', spoil: '0', lie: 'f' },
  ],
  'vndb/chars_vns': [
    { id: 'c6487', vid: 'v2002', rid: null, role: 'main', spoil: '2' },
    { id: 'c6487', vid: 'v2002', rid: 'r9', role: 'side', spoil: '1' },
  ],
  'vndb/traits': [
    { id: 'i23', name: 'Reviewed trait 23' },
    { id: 'i30', name: 'Reviewed trait 30' },
    { id: 'i99', name: 'Unreviewed trait' },
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
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
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
      ['trait-i23', 'skos:Concept', 'Reviewed trait 23'],
      ['trait-i30', 'skos:Concept', 'Reviewed trait 30'],
      ['trait-i99', 'skos:Concept', 'Unreviewed trait'],
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
      ['trait-i23', 'schema:url', characterTraitConceptUri('i23'), characterTraitConceptUri('i23')],
      ['trait-i23', 'skos:inScheme', ids.get('trait-scheme')!, characterTraitConceptUri('i23')],
      ['trait-i30', 'schema:url', characterTraitConceptUri('i30'), characterTraitConceptUri('i30')],
      ['trait-i30', 'skos:inScheme', ids.get('trait-scheme')!, characterTraitConceptUri('i30')],
      ['trait-i99', 'schema:url', characterTraitConceptUri('i99'), characterTraitConceptUri('i99')],
      ['trait-i99', 'skos:inScheme', ids.get('other-scheme')!, characterTraitConceptUri('i99')],
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
    const selected = await planCrossMediaSeed(tables, {
      selection: developmentShowcaseSelection,
      deferVndbCharacterAppearances: true,
    });
    const vocabulary = await planShowcaseCharacterVocabulary(tables, selected);
    expect(vocabulary.requirements.selectedWorkIds).toEqual(['v2002', 'v4']);
    expect(vocabulary.plan.entities.vndb.map((item) => item.key)).toEqual(['c6487']);

    const vocabularyPort = captureShowcaseCommands(runtime.importTransport as CrossMediaPort, journal);
    const roleTaxonomyRequirements = {
      ...vocabulary.requirements,
      terms: vocabulary.requirements.terms.filter((term) => term.taxonomy === appearanceRoleTaxonomy),
    };
    const prepareRoles = (stage: 'schemes' | 'concepts') =>
      prepareShowcaseCharacterVocabulary({
        tables,
        selectedPlan: selected,
        port: vocabularyPort,
        journal,
        stage,
        taxonomies: [appearanceRoleTaxonomy],
      });
    const sourceKeyId = (key: string) =>
      journal
        .acknowledgedCommands()
        .find(
          (ack) => ack.command.op === 'create' && ack.command.source.external_id === showcaseVocabularyExternalId(key),
        )?.subjectId;
    await prepareRoles('schemes');
    const roleSchemeId = sourceKeyId(appearanceRoleTaxonomy)!;
    await editor.adoptSubject(roleSchemeId, 'schema:url', appearanceRoleSchemeUri, GLOBAL_CONTEXT);
    await prepareRoles('concepts');
    const roleMainId = sourceKeyId(`${appearanceRoleTaxonomy}:main`)!;
    await editor.adoptSubject(roleMainId, 'schema:url', appearanceRoleConceptUri('main'), GLOBAL_CONTEXT);
    await editor.adoptSubject(roleMainId, 'skos:inScheme', roleSchemeId, GLOBAL_CONTEXT);
    const currentVocabulary = await readShowcaseCharacterVocabulary({
      tables,
      selectedPlan: selected,
      port: vocabularyPort,
      journal,
    });
    const profile = profileFromCharacterVocabularyBindings(currentVocabulary);
    expect(profile?.traits).toBeUndefined();
    expect(profile?.roles?.concepts).toEqual([{ code: 'main', id: roleMainId }]);
    const roleBindings = await composeVndbCharacterVocabularyBindings(
      runtime.importTransport,
      profile,
      roleTaxonomyRequirements,
    );
    const reviewedTraits = await prepareShowcaseVndbTraits(
      vocabulary.plan,
      vocabulary.plan,
      runtime.importTransport as CrossMediaPort,
      {
        'vndb-character-traits-scheme': ids.get('trait-scheme')!,
        'vndb-character-traits-i23': ids.get('trait-i23')!,
        'vndb-character-traits-i30': ids.get('trait-i30')!,
      },
    );
    expect(reviewedTraits.traits.map((row) => row.tid)).toEqual(['i23']);
    const bindings: SourceVocabularyBindings = {
      releaseDigest: bundledDigest,
      schemes: [...reviewedTraits.bindings.schemes, ...roleBindings.schemes],
      concepts: [...reviewedTraits.bindings.concepts, ...roleBindings.concepts],
    };
    expect(bindings.releaseDigest).toBe(bundledDigest);
    expect(bindings.concepts.map(({ code }) => code).sort()).toEqual(['i23', 'main']);

    const path = join(directory, 'state.sqlite');
    const imported = await importVndbCharacterTraits({
      tables,
      path,
      port: runtime.importTransport as CrossMediaPort,
      bindings,
      selectedWorkIds: vocabulary.requirements.selectedWorkIds,
      destination: { origin: 'https://kernel.import.test' },
    });
    const subjectId = (externalId: string) =>
      (imported.readings.find((item) => item.externalId === externalId)?.subject as { subject?: { id?: string } })
        .subject?.id;
    const heroineId = subjectId('c6487')!;
    const steinsGateId = subjectId('v2002')!;
    expect(new Set([heroineId, steinsGateId]).size).toBe(2);
    await editor.adoptSubject(heroineId, 'schema:keywords', ids.get('trait-i23')!, GLOBAL_CONTEXT);
    await editor.adoptSubject(steinsGateId, 'schema:character', heroineId, GLOBAL_CONTEXT);
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
    expect(trait?.value.content).toBe(ids.get('trait-i23'));
    expect(trait?.qualifiers).toContainEqual({
      property: { id: 'rezics:spoilerLevel' },
      value: { type: 'value', content: { amount: '+1', unit: '1' } },
    });
    expect(JSON.stringify(trait?.references)).toContain('/chars_traits/c6487/i23');
    const work = await read(steinsGateId);
    const appearance = work.subject.statements['schema:character']?.[0];
    expect(work.subject.type).toBe('wd:Q689445');
    expect(appearance?.value.content).toBe(heroineId);
    expect(appearance?.qualifiers).toContainEqual({
      property: { id: 'wdt:P3831' },
      value: { type: 'value', content: roleMainId },
    });
    expect(appearance?.qualifiers).toContainEqual({
      property: { id: 'rezics:spoilerLevel' },
      value: { type: 'value', content: { amount: '+2', unit: '1' } },
    });
    expect(JSON.stringify(appearance?.references)).toContain('/chars_vns/c6487/v2002');
    expect(JSON.stringify(appearance?.references)).not.toContain('/r9');
    expect(JSON.stringify([heroine.subject.statements, work.subject.statements])).not.toContain(ids.get('trait-i99'));
    const refreshed = await importVndbCharacterTraits({
      tables: {
        async *rows(provider, table) {
          for (const row of tableRows[`${provider}/${table}`] ?? [])
            yield table === 'vndb/chars_traits' && row.tid === 'i23' ? { ...row, spoil: '2' } : row;
        },
      },
      path,
      port: runtime.importTransport as CrossMediaPort,
      bindings,
      selectedWorkIds: vocabulary.requirements.selectedWorkIds,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(subjectIdFrom(refreshed, 'c6487')).toBe(heroineId);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

function subjectIdFrom(result: Awaited<ReturnType<typeof importVndbCharacterTraits>>, externalId: string) {
  return (result.readings.find((item) => item.externalId === externalId)?.subject as { subject?: { id?: string } })
    .subject?.id;
}
