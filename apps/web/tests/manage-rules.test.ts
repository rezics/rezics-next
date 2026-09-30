import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { settingsCommand } from '../../../services/main/src/modules/realm-admin/contract.ts';
import { uiLocales } from '../i18n/define.ts';
import { addRuleTranslation, compareRules, emptyRule, languageStatus, nextRevision, removeRuleTranslation, restoredRule,
  ruleFromText, ruleIdFrom, ruleProblems, setRuleOriginal, shownRule } from '../features/manage/rules.ts';
import type { RealmRule } from '../features/manage/types.ts';

const spoilers: RealmRule = { id: 'no-spoilers', governanceRule: null,
  title: { original: 'en', labels: { en: 'No spoilers', 'zh-Hans': '禁止剧透' } },
  body: { original: 'en', labels: { en: 'Mark plot details with a spoiler tag.', 'zh-Hans': '涉及情节的内容请加剧透标记。' } } };
const kind = ruleFromText('be-kind', 'Be kind', 'Criticise works, not people.', 'en');
const native: RealmRule = { id: 'native', governanceRule: null,
  title: { original: 'ja', labels: { ja: '親切に', ko: '친절하게' } },
  body: { original: 'ar', labels: { ar: 'احترم القراء' } } };

describe('meaning and presentation', () => {
  test('each field selects a recorded language and retains its original on fallback', () => {
    expect(shownRule(spoilers, 'zh-Hans').title).toEqual({ text: '禁止剧透', lang: 'zh-Hans', fallback: null });
    expect(shownRule(spoilers, 'ja').title).toEqual({ text: 'No spoilers', lang: 'en', fallback: 'en' });
    expect(shownRule(spoilers, 'zh-Hant').body.lang).toBe('en');
    expect(shownRule(native, 'ko')).toEqual({ title: { text: '친절하게', lang: 'ko', fallback: null },
      body: { text: 'احترم القراء', lang: 'ar', fallback: 'ar' } });
  });

  test('changing interface locale never retags or mutates authored text', () => {
    const before = structuredClone(native);
    for (const locale of uiLocales) {
      const shown = shownRule(native, locale);
      expect(Object.values(native.title.labels)).toContain(shown.title.text);
      expect(shown.body).toEqual({ text: 'احترم القراء', lang: 'ar', fallback: 'ar' });
    }
    expect(native).toEqual(before);
    const unrecorded = ruleFromText('unknown', '親切に', '読者を尊重する');
    for (const locale of uiLocales) expect(shownRule(unrecorded, locale).title.lang).toBe('und');
  });

  test('empty draft labels fall back to another recorded form without inventing English', () => {
    const draft = { ...native, title: { original: 'ko', labels: { ko: ' ', ja: '親切に' } } };
    expect(shownRule(draft, 'ko').title).toEqual({ text: '親切に', lang: 'ja', fallback: 'ja' });
    expect(shownRule(emptyRule('empty'), 'en').title).toEqual({ text: '', lang: 'und', fallback: 'und' });
  });
});

describe('authoring: edit, compare, publish', () => {
  test('edits retain originals and other translations, and flag unchanged wording', () => {
    const chineseOnly = { ...spoilers, body: { ...spoilers.body,
      labels: { ...spoilers.body.labels, 'zh-Hans': '涉及关键情节的内容请加剧透标记。' } } };
    expect(languageStatus(chineseOnly, spoilers)).toEqual({ en: 'check', 'zh-Hans': 'edited' });
    const both = { ...chineseOnly, title: { ...chineseOnly.title,
      labels: { ...chineseOnly.title.labels, en: 'No plot spoilers' } } };
    expect(languageStatus(both, spoilers)).toEqual({ en: 'edited', 'zh-Hans': 'edited' });
    expect(languageStatus(spoilers, spoilers)).toEqual({ en: 'unchanged', 'zh-Hans': 'unchanged' });
    expect(languageStatus(emptyRule('new'), undefined)).toEqual({ und: 'missing' });
    expect(languageStatus(native, undefined)).toEqual({ ja: 'new', ko: 'new', ar: 'new' });
    expect(ruleProblems([native])).toEqual([]);
  });

  test('comparison includes translation edits, additions, removals, moves and original-language changes', () => {
    const edited = { ...spoilers, title: { ...spoilers.title, labels: { ...spoilers.title.labels, 'zh-Hans': '不要剧透' } } };
    const added = ruleFromText('credit-sources', '注明出处', '注明文本来源。', 'zh-Hans');
    expect(compareRules([spoilers, kind], [edited, added])).toEqual([
      { kind: 'edited', rule: edited, languages: ['zh-Hans'], check: ['en'] },
      { kind: 'added', rule: added }, { kind: 'removed', rule: kind },
    ]);
    expect(compareRules([spoilers, kind], [spoilers, kind])).toEqual([]);
    expect(compareRules([spoilers, kind], [kind, spoilers]).map(change => change.kind)).toEqual(['moved', 'moved']);
    const retagged = { ...native, title: { ...native.title, original: 'ko' } };
    expect(compareRules([native], [retagged])).toEqual([
      { kind: 'edited', rule: retagged, languages: ['ko', 'ja'], check: ['ar'] },
    ]);
    const removed = { ...native, title: { ...native.title, labels: { ja: native.title.labels.ja! } } };
    expect(compareRules([native], [removed])[0]).toMatchObject({ kind: 'edited', languages: ['ko'] });
  });

  test('validation requires recorded originals, nonempty labels, bounds and unique identities without requiring translations', () => {
    expect(ruleProblems([spoilers, kind, native])).toEqual([]);
    expect(ruleProblems([{ ...spoilers, body: { original: 'en', labels: { en: 'x'.repeat(1001), 'zh-Hans': '' } } },
      { ...kind, id: 'no-spoilers' }])).toEqual([
      { index: 0, field: 'body', language: 'en', problem: 'too-long' },
      { index: 0, field: 'body', language: 'zh-Hans', problem: 'missing' },
      { index: 1, field: 'id', problem: 'duplicate' },
    ]);
    expect(ruleProblems([{ ...native, title: { original: 'ja', labels: { ko: '친절하게' } } }]))
      .toEqual([{ index: 0, field: 'title', language: 'ja', problem: 'missing' }]);
    expect(ruleProblems([{ ...native, title: { original: 'bad tag', labels: { 'bad tag': 'Title' } } }]))
      .toContainEqual({ index: 0, field: 'title', language: 'bad tag', problem: 'invalid' });
    expect(ruleProblems([{ ...kind, id: 'Be Kind' }])).toEqual([{ index: 0, field: 'id', problem: 'invalid' }]);
  });

  test('simple creation and new management rules produce the same v2 command shape with und', () => {
    const rules = [ruleFromText('rule-1', '親切に', '読者を尊重する')];
    expect(rules[0]!.title).toEqual({ original: 'und', labels: { und: '親切に' } });
    expect(ruleProblems(rules)).toEqual([]);
    expect(Value.Check(settingsCommand, {
      actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
      expectedGeneration: '0', expectedRulesRevision: null, reason: 'Set up the community',
      settings: { visibility: 'public', reviewRequired: false, whoMaySubmit: 'members', rules },
    })).toBe(true);
  });

  test('saved v1 drafts retain their text and normalize duplicated fields to und', () => {
    const legacy = { id: 'draft', governanceRule: null,
      title: { en: '親切に', 'zh-CN': '親切に' }, body: { en: 'Be kind', 'zh-CN': '友善' } };
    const restored = restoredRule(legacy as unknown as RealmRule);
    expect(restored.title).toEqual({ original: 'und', labels: { und: '親切に' } });
    expect(restored.body).toEqual({ original: 'en', labels: { en: 'Be kind', 'zh-Hans': '友善' } });
    expect(restoredRule(native)).toEqual(native);
  });

  test('rule identities derive from the authored title and stay unique', () => {
    expect(ruleIdFrom('No spoilers!', new Set())).toBe('no-spoilers');
    expect(ruleIdFrom('No spoilers', new Set(['no-spoilers', 'no-spoilers-2']))).toBe('no-spoilers-3');
    expect(ruleIdFrom('禁止剧透', new Set())).toBe('rule');
    expect(ruleIdFrom('Crème brûlée etiquette', new Set())).toBe('creme-brulee-etiquette');
  });

  test('publishing advances the revision without rewriting an earlier basis', () => {
    expect(nextRevision({ ref: 'urn:rezics:realm-rules:x', revision: null, digest: null })).toBe('1');
    expect(nextRevision({ ref: 'urn:rezics:realm-rules:x', revision: '41', digest: 'a'.repeat(64) })).toBe('42');
  });
});

describe('authoring in the author\u2019s language (G-515)', () => {
  const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const command = (rules: RealmRule[]) => ({ actingSubject: actor, expectedGeneration: '0', expectedRulesRevision: null,
    reason: 'Set up the community', settings: { visibility: 'public', reviewRequired: false, whoMaySubmit: 'members', rules } });

  test('a new rule starts in the language given, not in the interface locale', () => {
    const rule = emptyRule('rule', 'ja');
    expect(rule.title).toEqual({ original: 'ja', labels: { ja: '' } });
    expect(emptyRule('rule').title.original).toBe('und');
  });

  test('a rule written in Japanese is sent as Japanese with its translations as added', () => {
    const japanese = { ...ruleFromText('be-kind', '親切に', '読者を尊重する', 'ja') };
    const translated = addRuleTranslation(japanese, 'ko');
    expect(translated.title).toEqual({ original: 'ja', labels: { ja: '親切に', ko: '' } });
    expect(ruleProblems([translated])).toContainEqual({ index: 0, field: 'title', language: 'ko', problem: 'missing' });
    const filled = { ...translated, title: { ...translated.title, labels: { ja: '親切に', ko: '친절하게' } },
      body: { ...translated.body, labels: { ja: '読者を尊重する', ko: '독자를 존중하세요' } } };
    expect(ruleProblems([filled])).toEqual([]);
    expect(Value.Check(settingsCommand, command([filled]))).toBe(true);
    expect(removeRuleTranslation(filled, 'ko')).toEqual(japanese);
    expect(removeRuleTranslation(japanese, 'ja')).toEqual(japanese);
    expect(addRuleTranslation(filled, 'ko')).toEqual(filled);
  });

  test('correcting the original language moves the text and never loses a translation', () => {
    const unspecified = ruleFromText('be-kind', '親切に', '読者を尊重する');
    expect(setRuleOriginal(unspecified, 'ja')).toEqual(ruleFromText('be-kind', '親切に', '読者を尊重する', 'ja'));
    const withKorean = addRuleTranslation(ruleFromText('be-kind', '親切に', '読者を尊重する', 'ja'), 'ko');
    const swapped = setRuleOriginal({ ...withKorean, title: { ...withKorean.title, labels: { ja: '親切に', ko: '친절하게' } },
      body: { ...withKorean.body, labels: { ja: '読者を尊重する', ko: '독자를 존중하세요' } } }, 'ko');
    expect(swapped.title).toEqual({ original: 'ko', labels: { ja: '親切に', ko: '친절하게' } });
    expect(swapped.body.original).toBe('ko');
    expect(setRuleOriginal(unspecified, 'und')).toEqual(unspecified);
  });

  test('every authored rule payload names its original and keeps only what was written', () => {
    for (const rule of [ruleFromText('a', 'Title', 'Body', 'ko'), ruleFromText('b', 'عنوان', 'نص', 'ar')]) {
      expect(Object.keys(rule.title.labels)).toEqual([rule.title.original]);
      expect(Value.Check(settingsCommand, command([rule]))).toBe(true);
    }
  });
});
