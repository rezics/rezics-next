import { expect, test } from 'bun:test';
import {
  checkedPresentation,
  presentationDigest,
  type PresentationState,
} from '../src/modules/lexicon/schema.ts';
import { languageScript, selectedProjection } from '../src/modules/lexicon/render.ts';
import type { PresentationRead } from '../src/modules/lexicon/change.ts';
import { direction } from '../src/modules/display-language/select.ts';
import { semanticPredicateOutcome, semanticTypeOutcome } from '../src/modules/semantic/schema.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { uiLocales } from '../../../apps/web/i18n/define.ts';

const native = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;
const definition = native(),
  meaningRevision = native();
function state(language = 'de'): PresentationState {
  return {
    definition,
    meaningRevision,
    fromRole: 'source',
    toRole: 'target',
    language,
    noun: 'Adaption',
    heading: 'Adaptionen',
    plurals: { one: 'Adaption', other: 'Adaptionen' },
    grammaticalForms: [],
    source: 'https://example.com/source',
    licence: 'https://creativecommons.org/publicdomain/zero/1.0/',
    reviewStatus: 'draft',
  };
}
function row(language: string): PresentationRead {
  return {
    component: native(),
    revision: native(),
    predecessor: null,
    state: state(language),
    modelGeneration: 'urn:rezics:model-generation:test',
    sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' },
  };
}
test('G-832: bounded structured revisions accept non-UI languages and canonicalize equivalent intent', () => {
  expect(checkedPresentation(state('ar')).language).toBe('ar');
  expect(checkedPresentation(state('zh-hant-tw')).language).toBe('zh-Hant-TW');
  expect(
    checkedPresentation({
      ...state(),
      grammaticalForms: [
        { number: 'plural', case: 'dative', value: 'Adaptionen' },
        { gender: 'feminine', value: 'Adaption' },
      ],
    }).grammaticalForms,
  ).toHaveLength(2);
  expect(presentationDigest(undefined, null, state('zh-hant-tw'))).toBe(
    presentationDigest(undefined, null, state('zh-Hant-TW')),
  );
  expect(presentationDigest(undefined, null, state())).not.toBe(
    presentationDigest(undefined, null, { ...state(), noun: 'Bearbeitung' }),
  );
  for (const input of [
    { ...state(), plurals: {} },
    { ...state(), plurals: { other: 'x', invalid: 'x' } },
    { ...state(), fromRole: 'target' },
    { ...state(), language: 'bad_invalid' },
    { ...state(), noun: '' },
    { ...state(), sentenceTemplate: '{source} is {target}' },
    { ...state(), reviewStatus: 'approved' },
    { ...state(), grammaticalForms: [{ value: 'x' }] },
    {
      ...state(),
      grammaticalForms: [
        { case: 'dative', value: 'x' },
        { case: 'dative', value: 'y' },
      ],
    },
  ]) {
    expect(() => checkedPresentation(input)).toThrow();
  }
  expect(() => presentationDigest(native(), null, state())).toThrow();
});
test('G-832: selection has no twenty-language storage cap and discloses script and inverse fallbacks', () => {
  const tags = [
    'en',
    'de',
    'ar',
    'fr',
    'es',
    'ja',
    'ko',
    'it',
    'pt',
    'nl',
    'sv',
    'da',
    'no',
    'fi',
    'pl',
    'cs',
    'sk',
    'hu',
    'ro',
    'bg',
    'el',
    'tr',
    'uk',
    'vi',
    'id',
    'th',
    'sr-Latn',
    'zh-Hant',
  ];
  const rows = tags.map(row);
  expect(selectedProjection(rows, 'source', 'target', ['th'], []).language).toBe('th');
  const traditional = selectedProjection(rows, 'source', 'target', ['zh-Hant-TW'], []);
  expect(traditional).toMatchObject({
    language: 'zh-Hant',
    script: 'Hant',
    direction: 'ltr',
    fallback: { reason: 'language-fallback', crossedScript: false },
  });
  expect(selectedProjection(rows, 'source', 'target', ['sr-Latn'], [])).toMatchObject({
    script: 'Latn',
    fallback: null,
  });
  const crossing = selectedProjection([row('zh-Hans')], 'source', 'target', ['zh-Hant-TW'], []);
  expect(crossing).toMatchObject({
    script: 'Hans',
    fallback: {
      reason: 'script-fallback',
      requestedScript: 'Hant',
      usedScript: 'Hans',
      crossedScript: true,
      conversion: null,
    },
  });
  expect(selectedProjection(rows, 'target', 'source', ['de'], [])).toMatchObject({
    labels: null,
    language: null,
    fallback: { reason: 'missing-direction' },
  });
  expect(selectedProjection([row('ar')], 'source', 'target', ['ar'], [])).toMatchObject({
    script: 'Arab',
    direction: 'rtl',
  });
  expect(languageScript('az-Arab')).toBe('Arab');
});
test('G-832: generic semantic writes cannot impersonate or overwrite lexicon ownership', () => {
  for (const type of ['DefinitionPresentation', 'PresentationRevision'])
    expect(semanticTypeOutcome(`https://rezics.com/vocab/${type}`)).toBe('reserved-owner');
  for (const predicate of [
    'presentationHead',
    'presentationDefinition',
    'meaningRevision',
    'fromRole',
    'toRole',
    'presentationLanguage',
  ]) {
    expect(semanticPredicateOutcome(`https://rezics.com/vocab/${predicate}`)).toBe(
      'reserved-owner',
    );
  }
});
test('G-832: every bootstrap definition renders both directions in all UI locales', async () => {
  const writes: { path: string; body: Record<string, unknown>; key: string }[] = [];
  const seeded = await seedRelationLexicon(
    {
      post: async <T>(path: string, body: object, key: string) => {
        writes.push({ path, body: body as Record<string, unknown>, key });
        return { component: native(), revision: native() } as T;
      },
      authorizeDefinition: async () => {},
    },
    native(),
    'g-832',
  );
  expect(seeded).toHaveLength(15);
  expect(writes).toHaveLength(15 + 15 * 8 * 2);
  expect(new Set(writes.map((item) => item.key)).size).toBe(writes.length);
  for (const definition of seeded) {
    const rows = writes
      .filter(
        (item) =>
          item.path === '/v1/lexicon/presentations' &&
          (item.body.state as PresentationState).definition === definition.component,
      )
      .map((item) => ({ ...row('en'), state: checkedPresentation(item.body.state) }));
    const data = relationLexiconSeed.find((item) => item.key === definition.key)!;
    expect(rows).toHaveLength(16);
    for (const locale of uiLocales)
      for (const [from, to] of [data.roles, [...data.roles].reverse()]) {
        const rendering = selectedProjection(rows, from!, to!, [locale], []);
        expect(rendering.labels !== null || rendering.fallback !== null).toBe(true);
        expect(rendering.language).toBe(locale);
        expect(rendering.reviewStatus).toBe('draft');
        expect(rendering.fallback).toBeNull();
        expect(rendering.labels?.plurals.other).toBeTruthy();
        expect(rendering.script).toBe(languageScript(locale));
      }
  }
});
// G-504 owns the shared selector; keep its observed defect visible in the handoff.
test.todo('G-504: az-Arab rendering uses RTL direction from the shared selector', () => {
  expect(direction('az-Arab')).toBe('rtl');
});
