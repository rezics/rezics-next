import { expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, Source } from '@rezics/definitions/bulk';
import type { SourceRecord, SourceVocabularyBindings } from '../../../../packages/conversion/src/index.ts';
import { converter_revision as entityRevision } from '../../../../packages/conversion/src/cross-media-entities.ts';
import { crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { runBangumiCharacterFidelity } from '../../../importer/src/bangumi-character-fidelity.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const alias = crossMediaAliases.bangumi;
const trace = (phase: string) => console.info(`Bangumi native fixture: ${phase}`);
const authoredSource = (key: string): Source => ({
  source: 'bangumi',
  external_id: `authored-${key}`,
  record_revision: 'authored-1',
  digest: 'e'.repeat(64),
  converter_revision: 'authored-fixture@1',
  field_group: 'facts',
});

test('authored Bangumi character kinds and qualified appearances are adopted as current native facts', async () => {
  // All Bangumi records below are authored fixture data, not observed public dump evidence.
  trace('runtime open');
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  trace('runtime opened');
  try {
    const editor = await openApiObserver(runtime);
    trace('observer opened');
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    trace('grant created');

    async function createNative(type: 'skos:ConceptScheme' | 'skos:Concept', label: string, key: string) {
      const result = await runtime.importTransport.batch({
        commands: [
          {
            op: 'create',
            key: `authored-create-${key}`,
            source: authoredSource(key),
            subject: { type, labels: { en: label } },
          },
        ],
      });
      const row = result.results[0];
      expect(row?.status).toBe(201);
      if (!row || !('value' in row) || !('id' in row.value)) throw new Error(`Missing authored ${type}`);
      return row.value.id;
    }

    const kindSchemeId = await createNative('skos:ConceptScheme', 'Authored character kinds', 'kind-scheme');
    const appearanceSchemeId = await createNative('skos:ConceptScheme', 'Authored appearance roles', 'role-scheme');
    const kindOne = await createNative('skos:Concept', 'Authored kind one', 'kind-one');
    const kindTwo = await createNative('skos:Concept', 'Authored kind two', 'kind-two');
    const roleOne = await createNative('skos:Concept', 'Authored role one', 'role-one');
    const roleTwo = await createNative('skos:Concept', 'Authored role two', 'role-two');
    const roleThree = await createNative('skos:Concept', 'Authored role three', 'role-three');
    trace('concept subjects created');
    const authoredFacts: BatchCommand[] = [];
    const propose = (subject: string, key: string, property: string, value: string) => {
      authoredFacts.push({
        op: 'propose',
        key: `authored-propose-${key}`,
        source: authoredSource(key),
        subject,
        statement: {
          property: { id: property },
          value: { type: 'value', content: value },
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:url' },
                  value: { type: 'value', content: `https://example.test/authored/${key}` },
                },
              ],
            },
          ],
        },
      });
    };
    propose(kindSchemeId, 'kind-scheme-url', 'schema:url', 'https://rezics.com/schemes/bangumi/character-kinds');
    propose(appearanceSchemeId, 'role-scheme-url', 'schema:url', 'https://rezics.com/schemes/bangumi/appearance-roles');
    for (const [number, id] of [
      [1, kindOne],
      [2, kindTwo],
    ] as const)
      propose(id, `kind-${number}-url`, 'schema:url', `https://rezics.com/schemes/bangumi/character-kinds/${number}`);
    for (const [number, id] of [
      [1, roleOne],
      [2, roleTwo],
      [3, roleThree],
    ] as const) {
      propose(id, `role-${number}-url`, 'schema:url', `https://rezics.com/schemes/bangumi/appearance-roles/${number}`);
      propose(id, `role-${number}-scheme`, 'skos:inScheme', appearanceSchemeId);
    }
    for (const [number, id] of [
      [1, kindOne],
      [2, kindTwo],
    ] as const)
      propose(id, `kind-${number}-scheme`, 'skos:inScheme', kindSchemeId);
    for (let offset = 0; offset < authoredFacts.length; offset += 8) {
      const facts = await runtime.importTransport.batch({ commands: authoredFacts.slice(offset, offset + 8) });
      expect(facts.results.every((row) => row.status === 201)).toBe(true);
    }
    for (const [id, uri] of [
      [kindSchemeId, 'https://rezics.com/schemes/bangumi/character-kinds'],
      [appearanceSchemeId, 'https://rezics.com/schemes/bangumi/appearance-roles'],
      [kindOne, 'https://rezics.com/schemes/bangumi/character-kinds/1'],
      [kindTwo, 'https://rezics.com/schemes/bangumi/character-kinds/2'],
      [roleOne, 'https://rezics.com/schemes/bangumi/appearance-roles/1'],
      [roleTwo, 'https://rezics.com/schemes/bangumi/appearance-roles/2'],
      [roleThree, 'https://rezics.com/schemes/bangumi/appearance-roles/3'],
    ] as const) {
      await editor.adoptSubject(id, 'schema:url', uri, globalContext);
      if (id === kindOne || id === kindTwo) await editor.adoptSubject(id, 'skos:inScheme', kindSchemeId, globalContext);
      if (id === roleOne || id === roleTwo || id === roleThree)
        await editor.adoptSubject(id, 'skos:inScheme', appearanceSchemeId, globalContext);
    }
    trace('concepts adopted');

    const records: SourceRecord[] = [
      {
        source: 'bangumi',
        key: '990010',
        revision: 'authored-1',
        payload: {
          id: 990010,
          type: 2,
          name: 'Authored anime work',
          name_cn: '原創動畫',
          summary: 'An authored synopsis.',
        },
      },
      {
        source: 'bangumi',
        key: 'character:990001',
        revision: 'authored-1',
        payload: {
          id: 990001,
          type: 1,
          name: 'Authored character one',
          name_cn: '原創角色一',
          summary: 'A character synopsis.',
        },
      },
      {
        source: 'bangumi',
        key: 'character:990002',
        revision: 'authored-1',
        payload: { id: 990002, type: 2, name: 'Authored character two', name_cn: '原創角色二' },
      },
      {
        source: 'bangumi',
        key: 'person:990020',
        revision: 'authored-1',
        payload: { id: 990020, name: 'Authored person' },
      },
    ];
    const registration = createSourceRegistration('bangumi', { source: alias, converterRevision: entityRevision });
    const initial = await runtime.importer.runRecords(
      registration,
      (async function* () {
        yield* records;
      })(),
    );
    expect(initial.status).toBe('committed');
    trace('source identities imported');
    await editor.adopt(alias, '990010', 'wdt:P5732', '990010');
    await editor.adopt(alias, 'character:990001', 'wdt:P6296', '990001');
    await editor.adopt(alias, 'character:990002', 'wdt:P6296', '990002');
    trace('source identities adopted');

    const bindings: SourceVocabularyBindings = {
      releaseDigest: bundledDigest,
      schemes: [
        {
          taxonomy: 'bangumi.character.role',
          id: kindSchemeId,
          uri: 'https://rezics.com/schemes/bangumi/character-kinds',
          type: 'skos:ConceptScheme',
          releaseDigest: bundledDigest,
        },
        {
          taxonomy: 'bangumi.subject-characters.type',
          id: appearanceSchemeId,
          uri: 'https://rezics.com/schemes/bangumi/appearance-roles',
          type: 'skos:ConceptScheme',
          releaseDigest: bundledDigest,
        },
      ],
      concepts: [
        ...[
          ['1', kindOne, kindSchemeId],
          ['2', kindTwo, kindSchemeId],
        ].map(([code, id, schemeId]) => ({
          taxonomy: 'bangumi.character.role' as const,
          code: code as string,
          id: id as string,
          type: 'skos:Concept' as const,
          schemeId: schemeId as string,
          releaseDigest: bundledDigest,
        })),
        ...[
          ['1', roleOne],
          ['2', roleTwo],
          ['3', roleThree],
        ].map(([code, id]) => ({
          taxonomy: 'bangumi.subject-characters.type' as const,
          code: code as string,
          id: id as string,
          type: 'skos:Concept' as const,
          schemeId: appearanceSchemeId,
          releaseDigest: bundledDigest,
        })),
      ],
    };
    const appearance = { subjectId: '990010', characterId: 990001, sourceIndex: 2, roleCode: 1, order: 0 } as const;
    const runFidelity = (roleCode: number, selectedBindings = bindings) =>
      runBangumiCharacterFidelity({
        importer: runtime.importer,
        port: runtime.importTransport,
        sourceAlias: alias,
        records,
        appearances: [{ ...appearance, roleCode }],
        bindings: selectedBindings,
      });

    const first = await runFidelity(1);
    trace('first fidelity run');
    expect(first.run.status).toBe('committed');
    expect(first.gaps).toContainEqual(
      expect.objectContaining({
        path: '/subject-characters/2/type',
        reason: 'qualifier_not_admitted',
        property: 'schema:position',
      }),
    );
    const workId = runtime.importer.session.bindings.claim({ source: alias, external_id: '990010' });
    const characterId = runtime.importer.session.bindings.claim({ source: alias, external_id: 'character:990001' });
    const secondCharacterId = runtime.importer.session.bindings.claim({
      source: alias,
      external_id: 'character:990002',
    });
    const personId = runtime.importer.session.bindings.claim({ source: alias, external_id: 'person:990020' });
    if (
      workId?.state !== 'bound' ||
      characterId?.state !== 'bound' ||
      secondCharacterId?.state !== 'bound' ||
      personId?.state !== 'bound'
    )
      throw new Error('Missing authored source identity');
    const workView = await editor.read(alias, '990010');
    const characterView = await editor.read(alias, 'character:990001');
    const characterTwoView = await editor.read(alias, 'character:990002');
    const personView = await editor.read(alias, 'person:990020');
    trace('native subjects read');
    expect(workView.subject?.type).toBe('schema:TVSeries');
    expect(characterView.subject?.type).toBe('wd:Q95074');
    expect(characterTwoView.subject?.type).toBe('wd:Q95074');
    expect(personView.subject?.type).toBe('schema:Person');
    expect(workView.proposals.some((item) => item.statement?.property.id === 'schema:name')).toBe(true);
    const kind = characterView.proposals.find((item) => item.statement?.property.id === 'schema:keywords');
    const appearanceProposal = workView.proposals.find((item) => item.statement?.property.id === 'schema:character');
    expect(kind?.statement).toMatchObject({
      value: { type: 'value', content: kindOne },
      references: [
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              property: { id: 'schema:url' },
              value: { type: 'value', content: 'https://bgm.tv/character/990001#/character/990001/type' },
            }),
          ]),
        }),
      ],
    });
    expect(appearanceProposal?.statement).toMatchObject({
      value: { type: 'value', content: characterId.subject },
      qualifiers: [{ property: { id: 'wdt:P3831' }, value: { type: 'value', content: roleOne } }],
      references: [
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              property: { id: 'schema:url' },
              value: { type: 'value', content: 'https://bgm.tv/subject/990010#/subject-characters/2/type' },
            }),
          ]),
        }),
      ],
    });
    await editor.adoptSubject(characterId.subject, 'schema:keywords', kindOne, globalContext);
    await editor.adoptSubject(workId.subject, 'schema:character', characterId.subject, globalContext);
    trace('native facts adopted');
    const adoptedWorkValue = (await runtime.importTransport.readReviewedSubject(workId.subject)).subject?.statements[
      'schema:character'
    ]?.[0]?.value;
    const adoptedCharacterValue = (await runtime.importTransport.readReviewedSubject(characterId.subject)).subject
      ?.statements['schema:keywords']?.[0]?.value;
    expect(adoptedWorkValue?.type === 'value' ? adoptedWorkValue.content : undefined).toBe(characterId.subject);
    expect(adoptedCharacterValue?.type === 'value' ? adoptedCharacterValue.content : undefined).toBe(kindOne);

    const originalCandidateIds = workView.proposals
      .filter((item) => item.statement?.property.id === 'schema:character')
      .map((item) => item.id);
    const same = await runFidelity(1);
    trace('idempotent replay');
    expect(same.run.status).toBe('committed');
    await runtime.restart();
    trace('importer reopened');
    const reopened = await runFidelity(1);
    trace('reopened replay');
    expect(reopened.run.status).toBe('committed');
    expect(
      (await editor.read(alias, '990010')).proposals
        .filter((item) => item.statement?.property.id === 'schema:character')
        .map((item) => item.id),
    ).toEqual(originalCandidateIds);

    const changedRole = await runFidelity(2);
    trace('changed role replay');
    expect(changedRole.run.status).toBe('committed');
    expect(
      (await editor.read(alias, '990010')).proposals.some((item) =>
        item.statement?.qualifiers?.some((qualifier) => qualifier.value.content === roleTwo),
      ),
    ).toBe(true);
    const missingRole = await runFidelity(3, {
      ...bindings,
      concepts: bindings.concepts.filter((item) => item.id !== roleThree),
    });
    trace('missing binding replay');
    expect(missingRole.gaps).toContainEqual(
      expect.objectContaining({ reason: 'missing_concept', code: '3', path: '/subject-characters/2/type' }),
    );

    await editor.takedown(alias, '990010', 'facts');
    trace('tuple retracted');
    const fenced = await runFidelity(3);
    trace('fenced replay');
    expect(fenced.run.status).toBe('committed');
    expect(
      (await editor.read(alias, '990010')).proposals.some((item) =>
        item.statement?.qualifiers?.some((qualifier) => qualifier.value.content === roleThree),
      ),
    ).toBe(false);
  } finally {
    await runtime.close();
  }
}, 300_000);
