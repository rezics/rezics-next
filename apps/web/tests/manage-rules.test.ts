import { describe, expect, test } from 'bun:test';
import { uiLocales } from '../i18n/define.ts';
import { compareRules, emptyRule, languageStatus, nextRevision, ruleIdFrom, ruleLanguageFor, ruleProblems,
  shownRule } from '../features/manage/rules.ts';
import type { RealmRule } from '../features/manage/types.ts';

// Realm rules have one approved meaning (the published revision moderators
// cite) and localized forms. These tests hold the semantics that the Realm
// rule authoring page used to describe.

const spoilers: RealmRule = { id: 'no-spoilers', governanceRule: null,
  title: { en: 'No spoilers', 'zh-CN': '禁止剧透' },
  body: { en: 'Mark plot details with a spoiler tag.', 'zh-CN': '涉及情节的内容请加剧透标记。' } };
const kind: RealmRule = { id: 'be-kind', governanceRule: null,
  title: { en: 'Be kind', 'zh-CN': '友善待人' }, body: { en: 'Criticise works, not people.', 'zh-CN': '批评作品，不针对人。' } };

describe('meaning and presentation', () => {
  test('every interface locale reads a stored language, and says when it is not its own', () => {
    expect(ruleLanguageFor('en')).toEqual({ language: 'en', exact: true });
    expect(ruleLanguageFor('zh-Hans')).toEqual({ language: 'zh-CN', exact: true });
    expect(ruleLanguageFor('zh-Hant')).toEqual({ language: 'zh-CN', exact: false });
    for (const locale of ['ja', 'ko', 'de', 'fr', 'es'] as const) {
      expect(ruleLanguageFor(locale)).toEqual({ language: 'en', exact: false });
    }
  });

  test('a fallback names the language actually shown and tags the text with it', () => {
    expect(shownRule(spoilers, 'zh-Hans').title).toEqual({ text: '禁止剧透', lang: 'zh-Hans', fallback: null });
    expect(shownRule(spoilers, 'ja').title).toEqual({ text: 'No spoilers', lang: 'en', fallback: 'en' });
    expect(shownRule(spoilers, 'zh-Hant').body).toEqual({ text: '涉及情节的内容请加剧透标记。', lang: 'zh-Hans',
      fallback: 'zh-CN' });
  });

  test('changing the interface locale never changes which text belongs to which rule', () => {
    const shown = uiLocales.map(locale => shownRule(spoilers, locale));
    for (const rule of shown) {
      expect([spoilers.title.en, spoilers.title['zh-CN']]).toContain(rule.title.text);
      expect(rule.title.lang).toBe(rule.body.lang);
    }
  });

  test('a language missing from a draft falls back explicitly instead of showing nothing', () => {
    const draft = { ...spoilers, title: { en: 'No spoilers', 'zh-CN': ' ' }, body: { en: 'Tag them.', 'zh-CN': '' } };
    expect(shownRule(draft, 'zh-Hans').title).toEqual({ text: 'No spoilers', lang: 'en', fallback: 'en' });
  });
});

describe('authoring: edit, compare, publish', () => {
  test('independent localized edits are tracked per language, and the other language is flagged to check', () => {
    const chineseOnly = { ...spoilers, body: { ...spoilers.body, 'zh-CN': '涉及关键情节的内容请加剧透标记。' } };
    expect(languageStatus(chineseOnly, spoilers)).toEqual({ en: 'check', 'zh-CN': 'edited' });
    const both = { ...chineseOnly, title: { ...chineseOnly.title, en: 'No plot spoilers' } };
    expect(languageStatus(both, spoilers)).toEqual({ en: 'edited', 'zh-CN': 'edited' });
    expect(languageStatus(spoilers, spoilers)).toEqual({ en: 'unchanged', 'zh-CN': 'unchanged' });
    expect(languageStatus(emptyRule('new'), undefined)).toEqual({ en: 'missing', 'zh-CN': 'missing' });
    expect(languageStatus({ title: kind.title, body: kind.body }, undefined)).toEqual({ en: 'new', 'zh-CN': 'new' });
  });

  test('comparing names every change a publication would make, including translation-only edits', () => {
    const edited = { ...kind, title: { ...kind.title, 'zh-CN': '友善' } };
    const added = { ...emptyRule('credit-sources'), title: { en: 'Credit sources', 'zh-CN': '注明出处' },
      body: { en: 'Link to where a text came from.', 'zh-CN': '注明文本来源。' } };
    expect(compareRules([spoilers, kind], [edited, added])).toEqual([
      // Removing the first rule does not move the second: its order among the kept rules is unchanged.
      { kind: 'edited', rule: edited, languages: ['zh-CN'], check: ['en'] },
      { kind: 'added', rule: added },
      { kind: 'removed', rule: spoilers },
    ]);
    expect(compareRules([spoilers, kind], [spoilers, kind])).toEqual([]);
    expect(compareRules([spoilers, kind], [kind, spoilers]).map(change => change.kind)).toEqual(['moved', 'moved']);
  });

  test('a draft Main would refuse is caught before publishing: both languages, lengths and unique identities', () => {
    expect(ruleProblems([spoilers, kind])).toEqual([]);
    expect(ruleProblems([{ ...spoilers, body: { en: 'x'.repeat(1001), 'zh-CN': '' } }, { ...kind, id: 'no-spoilers' }]))
      .toEqual([
        { index: 0, field: 'body', language: 'en', problem: 'too-long' },
        { index: 0, field: 'body', language: 'zh-CN', problem: 'missing' },
        { index: 1, field: 'id', problem: 'duplicate' },
      ]);
    expect(ruleProblems([{ ...kind, id: 'Be Kind' }])).toEqual([{ index: 0, field: 'id', problem: 'invalid' }]);
  });

  test('rule identities come from the English title and stay unique', () => {
    expect(ruleIdFrom('No spoilers!', new Set())).toBe('no-spoilers');
    expect(ruleIdFrom('No spoilers', new Set(['no-spoilers', 'no-spoilers-2']))).toBe('no-spoilers-3');
    expect(ruleIdFrom('禁止剧透', new Set())).toBe('rule');
    expect(ruleIdFrom('Crème brûlée etiquette', new Set())).toBe('creme-brulee-etiquette');
  });

  test('publishing creates the next revision; earlier revisions are never rewritten', () => {
    expect(nextRevision({ ref: 'urn:rezics:realm-rules:x', revision: null, digest: null })).toBe('1');
    expect(nextRevision({ ref: 'urn:rezics:realm-rules:x', revision: '41', digest: 'a'.repeat(64) })).toBe('42');
  });
});
