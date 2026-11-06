import { bundledRelease } from '@rezics/definitions/bundled';
import { normalizeSourceStatement } from '../../../src/semantic/scope-leaf-selection.ts';
import type { IndexedStatement, IndexedSubject } from '../../../src/search/source.ts';

/** Released Semantic name/alias statements. Search does not mint another name authority. */
export const RELEASED_NAME_STATEMENTS = [
  ['schema:name', 'zh-Hans', '命运石之门'],
  ['schema:name', 'zh-Hant', '命運石之門'],
  ['schema:alternateName', 'und', 'シュタインズ・ゲート'],
  ['schema:alternateName', 'und', 'Shutage'],
  ['schema:name', 'zh-Latn', 'Mingyun Shi zhi Men'],
] as const;

export const RELEASED_NAME_ID = '018f0000-0000-7000-8000-00a000000001';
export const RELEASED_DECOY_ID = '018f0000-0000-7000-8000-00a00000000a';

export function releasedNameStatements(
  names: readonly (readonly [string, string, string])[] = RELEASED_NAME_STATEMENTS,
): IndexedStatement[] {
  return names.map(
    ([property, language, text]) =>
      normalizeSourceStatement(
        property,
        { value: { type: 'value', content: { language, text } } },
        bundledRelease.properties,
      )!,
  );
}

export function releasedMultilingualSubject(patch: Partial<IndexedSubject> = {}): IndexedSubject {
  return {
    id: RELEASED_NAME_ID,
    type: 'schema:VideoGame',
    visibility: 'visible',
    redirect: null,
    securityRevision: 7,
    labels: [
      { language: 'en', value: 'Steins;Gate' },
      { language: 'zh-Hant', value: '命運石之門' },
      { language: 'ja', value: 'STEINS;GATE' },
    ],
    aliases: [
      { language: 'und', value: 'シュタインズ・ゲート' },
      { language: 'und', value: 'シュタゲ' },
      { language: 'und', value: 'Shutage' },
      { language: 'zh-Hans', value: '石头门' },
      { language: 'und', value: 'シュタインズ・ゲート' },
      ...Array.from({ length: 64 }, (_, n) => ({ language: 'und' as const, value: `Other accepted name ${n}` })),
    ],
    descriptions: [{ language: 'en', value: 'A science adventure.' }],
    statements: releasedNameStatements(),
    ...patch,
  };
}

export function releasedDecoySubject(): IndexedSubject {
  return {
    id: RELEASED_DECOY_ID,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [
      { language: 'zh-Hant', value: '魔法禁書索引' },
      { language: 'en', value: 'A Different Catalogue' },
    ],
    aliases: [],
    descriptions: [],
    statements: [],
  };
}

export const RELEASED_CURRENT_PUBLICATION: IndexedSubject = {
  ...releasedMultilingualSubject({
    securityRevision: 8,
    labels: [
      { language: 'en', value: 'Steins;Gate Elite' },
      { language: 'zh-Hant', value: '命運石之門 Elite' },
      { language: 'ja', value: 'STEINS;GATE ELITE' },
    ],
    aliases: [
      { language: 'und', value: 'シュタインズ・ゲート' },
      { language: 'zh-Hans', value: '石头门' },
    ],
    statements: releasedNameStatements([
      ['schema:name', 'zh-Hans', '命运石之门 Elite'],
      ['schema:name', 'zh-Hant', '命運石之門 Elite'],
    ]),
  }),
};
