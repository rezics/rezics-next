import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { normalizeSourceStatement } from '../../src/semantic/scope-leaf-selection.ts';
import { documentActions } from '../../src/search/document.ts';
import { projectHit } from '../../src/search/hits.ts';
import { compileMatchEvidence, projectMatchEvidence } from '../../src/search/match-evidence.ts';
import { compileText, parseText } from '../../src/search/text.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

test('adopted names beyond display terms reach shared documents and current evidence with original language', () => {
  const names = [
    ['schema:name', 'zh-Hans', '命运石之门'],
    ['schema:name', 'zh-Hant', '命運石之門'],
    ['schema:alternateName', 'und', 'シュタインズ・ゲート'],
    ['schema:alternateName', 'und', 'Shutage'],
    ['schema:name', 'zh-Latn', 'Mingyun Shi zhi Men'],
  ] as const;
  const subject: IndexedSubject = {
    id: '018f0000-0000-7000-8000-00a000000001',
    type: 'schema:VideoGame',
    visibility: 'visible',
    redirect: null,
    securityRevision: 7,
    labels: [
      { language: 'en', value: 'Steins;Gate' },
      { language: 'zh-Hant', value: '命運石之門' },
      { language: 'ja', value: 'STEINS;GATE' },
    ],
    aliases: Array.from({ length: 64 }, (_, n) => ({ language: 'und', value: `Other accepted name ${n}` })),
    descriptions: [{ language: 'en', value: 'A science adventure.' }],
    statements: names.map(([property, language, text]) =>
      normalizeSourceStatement(
        property,
        { value: { type: 'value', content: { language, text } } },
        bundledRelease.properties,
      )!,
    ),
  };
  const action = documentActions({ partition: 10, position: 1n, subjects: [subject] }, [subject.id])[0]!;
  expect(action.op).toBe('index');
  if (action.op !== 'index') throw new Error('Expected public document');
  for (const [, , value] of names) expect(action.document.names).toContain(value);
  expect(action.document.names.filter((value) => value === '命運石之門')).toHaveLength(1);
  expect(action.document.descriptions).toEqual(['A science adventure.']);
  const plan = compileMatchEvidence(compileText(parseText('shutage'), { field: 'search_text', prefix: 't' }));
  const evidence = projectMatchEvidence(
    subject,
    { matched: ['e_n_t0'], highlight: { names: ['<em>Shutage</em>'] } },
    plan,
  );
  expect(evidence).toMatchObject({ state: 'current', reasons: [{ field: 'alias', language: 'und', text: 'Shutage' }] });
  for (const language of ['en', 'zh-Hant', 'ja'])
    expect(projectHit(subject, { descriptions: false, languages: [language], matchEvidence: evidence }).labels).toEqual(
      { [language]: subject.labels.find((name) => name.language === language)!.value },
    );
  // Stale/transformed excerpts cannot borrow offsets from the displayed Chinese title.
  expect(
    projectMatchEvidence(subject, { matched: ['e_n_t0'], highlight: { names: ['<em>shutage</em>'] } }, plan),
  ).toEqual({ state: 'unavailable' });
  expect(
    projectMatchEvidence(
      { ...subject, statements: [] },
      { matched: ['e_n_t0'], highlight: { names: ['<em>Shutage</em>'] } },
      plan,
    ),
  ).toEqual({ state: 'unavailable' });
});
