import { expect, test } from 'bun:test';
import { sourceDigest } from '@rezics/conversion/support';
import type { BatchCommand } from '@rezics/definitions/bulk';
import {
  crossMediaAliases,
  emptyCrossMediaPlan,
  showcaseDigest,
  showcaseLimits,
  showcasePlanRecordDigest,
  showcaseVocabularyExternalId,
  type ShowcaseAcknowledgement,
} from '../src/showcase-contract.ts';
import { buildShowcaseManifest, showcasePlanDigest } from '../src/showcase-manifest.ts';

test('selected publication digest and empty plan load from the owner-local contract', () => {
  const plan = emptyCrossMediaPlan();
  expect(plan.records.bangumi).toEqual([]);
  expect(plan.entities.vndb).toEqual([]);
  expect(showcaseLimits.records).toBe(768);
  const digest = showcaseDigest({ records: plan.records, entities: plan.entities });
  expect(digest).toBe(showcaseDigest({ records: plan.records, entities: plan.entities }));
  expect(digest).not.toBe(sourceDigest({ records: plan.records, entities: plan.entities }));
  expect(showcasePlanRecordDigest(plan)).toEqual({
    records: { bangumi: [], vndb: [] },
    entities: { bangumi: [], vndb: [] },
  });
  expect(showcasePlanDigest(plan).length).toBe(64);
});

test('vocabulary retains the first exact create and distinct ordered candidates of the current selection', () => {
  const plan = emptyCrossMediaPlan();
  plan.records.bangumi.push({ source: 'bangumi', key: '1', revision: null, payload: {} });
  const aliases = crossMediaAliases;
  const sourceKey = 'test-scheme';
  const sourceUri = 'https://bgm.tv/test-scheme';
  const source: BatchCommand['source'] = {
    source: aliases.bangumi,
    external_id: showcaseVocabularyExternalId(sourceKey),
    record_revision: 'unversioned',
    digest: 'a'.repeat(64),
    converter_revision: 'test-scheme@1',
    field_group: 'facts',
  };
  const create = (subjectId: string, claim = source): ShowcaseAcknowledgement => {
    const command: BatchCommand = {
      op: 'create',
      key: 'scheme',
      source: claim,
      subject: { type: 'skos:ConceptScheme', labels: { en: sourceKey } },
    };
    return { command, subjectId, commandDigest: showcaseDigest(command) };
  };
  const propose = (subject: string, candidateId: string): ShowcaseAcknowledgement => {
    const command: BatchCommand = {
      op: 'propose',
      key: candidateId,
      source,
      subject,
      statement: { property: { id: 'schema:url' }, value: { type: 'value', content: sourceUri }, references: [] },
    };
    return { command, candidateId, commandDigest: showcaseDigest(command) };
  };
  const stale = create('stale', { ...source, record_revision: 'older' });
  const previous = create('previous');
  const current = create('current');
  const first = propose('previous', '00000000-0000-4000-8000-000000000001');
  const second = propose('previous', '00000000-0000-4000-8000-000000000002');
  const changed = propose('current', '00000000-0000-4000-8000-000000000003');
  const build = (acknowledgements: ShowcaseAcknowledgement[]) =>
    buildShowcaseManifest({
      plan,
      vocabularyOnly: true,
      readings: [],
      aliases,
      acknowledgements,
      vocabularyRequirements: [
        { provider: 'bangumi', ownerKey: '1', sourceKey, sourceUri, source, nativeType: 'skos:ConceptScheme' },
      ],
    }).vocabulary[0]!;
  const initial = build([
    stale,
    { ...current, commandDigest: 'invalid' },
    previous,
    current,
    second,
    changed,
    first,
    second,
  ]);
  expect(initial.subjectId).toBe(previous.subjectId!);
  expect(initial.assertions.map(({ candidateId }) => candidateId)).toEqual([second.candidateId!, first.candidateId!]);
  const refreshed = build([stale, current, previous, second, changed, first]);
  expect(refreshed.subjectId).toBe(current.subjectId!);
  expect(refreshed.assertions.map(({ candidateId }) => candidateId)).toEqual([changed.candidateId!]);
});
