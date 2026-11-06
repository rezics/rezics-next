import { expect, test } from 'bun:test';
import { publicAliases } from '../../src/search/document-names.ts';
import { documentActions } from '../../src/search/document.ts';
import { projectHit } from '../../src/search/hits.ts';
import { compileMatchEvidence, projectMatchEvidence } from '../../src/search/match-evidence.ts';
import { compileText, parseText } from '../../src/search/text.ts';
import { RELEASED_NAME_STATEMENTS, releasedMultilingualSubject } from './support/released-names.ts';

test('adopted names beyond display terms reach shared documents and current evidence with original language', () => {
  const subject = releasedMultilingualSubject({
    aliases: Array.from({ length: 64 }, (_, n) => ({ language: 'und', value: `Other accepted name ${n}` })),
  });
  const action = documentActions({ partition: 10, position: 1n, subjects: [subject] }, [subject.id])[0]!;
  expect(action.op).toBe('index');
  if (action.op !== 'index') throw new Error('Expected public document');
  for (const [, , value] of RELEASED_NAME_STATEMENTS) expect(action.document.names).toContain(value);
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

test('displayed aliases keep every stored language in native order independently of the reader locale', () => {
  const subject = releasedMultilingualSubject({
    aliases: [
      { language: 'und', value: 'シュタインズ・ゲート' },
      { language: 'und', value: 'シュタゲ' },
      { language: 'und', value: 'Shutage' },
      { language: 'zh-Hans', value: '石头门' },
      { language: 'und', value: 'シュタインズ・ゲート' },
    ],
    descriptions: [],
    statements: [],
  });
  expect(publicAliases(subject)).toEqual({
    und: ['シュタインズ・ゲート', 'シュタゲ', 'Shutage'],
    'zh-Hans': ['石头门'],
  });
  expect(projectHit(subject, { descriptions: false, languages: ['zh-Hant'] }).labels).toEqual({
    'zh-Hant': '命運石之門',
  });
  expect(projectHit(subject, { descriptions: false, languages: ['ja'] }).labels).toEqual({ ja: 'STEINS;GATE' });
});
