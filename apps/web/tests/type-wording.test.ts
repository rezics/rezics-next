import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('catalogue selectors, chips and recovery use Type in all eight launch locales', () => {
  const locales = [
    ['en', 'Type', /\bkinds?\b/i, /types?/i],
    ['zh-Hans', '类型', /种类|类别/, /类型/],
    ['zh-Hant', '類型', /種類|類別/, /類型/],
    ['ja', 'タイプ', /種類/, /タイプ/],
    ['ko', '유형', /종류/, /유형/],
    ['de', 'Typ', /\b(?:art|arten|ergebnisarten?)\b/i, /typ/i],
    ['fr', 'Type', /catégorie|genre|sorte/i, /type/i],
    ['es', 'Tipo', /categoría|clase/i, /tipo/i],
  ] as const;
  const keys = [
    'home_kind_label',
    'home_kind_all',
    'home_kind_unnamed',
    'home_kinds_load',
    'home_kinds_loading',
    'home_kinds_empty',
    'home_kinds_unavailable',
    'home_kinds_retry',
    'home_kinds_next',
    'search_type',
    'search_types',
    'search_clear_type',
    'search_result_kind',
    'search_result_kinds',
    'search_all_kinds',
    'search_choose_kinds',
    'search_result_kinds_help',
    'search_subject_type_help',
    'search_kind_navigation_selected',
    'search_kind_navigation_more',
    'search_constraint_identity_kind_unavailable',
    'discovery_more_kinds',
  ];
  for (const [locale, label, kind, type] of locales) {
    const messages = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'messages', `${locale}.json`), 'utf8'),
    ) as Record<string, string>;
    expect(messages.home_kind_label, locale).toBe(label);
    for (const key of keys) {
      const text = messages[key]?.trim() ?? '';
      expect(text, `${locale}: ${key}`).not.toBe('');
      expect(text, `${locale}: ${key}`).not.toMatch(kind);
      expect(text, `${locale}: ${key}`).toMatch(type);
    }
  }
});
