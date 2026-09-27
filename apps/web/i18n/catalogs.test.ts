import { expect, test } from 'bun:test';
import { catalogs } from './catalogs.ts';
import { uiLocales } from './define.ts';
import { i18n } from './locale.ts';

function shape(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return typeof value;
  if ('$nativeI18n' in value) return 'recipe';
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shape(entry)]).sort());
}

test('every feature catalog has the same keys in every interface locale', async () => {
  for (const [namespace, load] of Object.entries(catalogs)) {
    const catalog: Record<string, unknown> = await load();
    for (const locale of uiLocales) {
      expect({ namespace, locale, shape: shape(catalog[locale]) })
        .toEqual({ namespace, locale, shape: shape(catalog.en) });
    }
  }
});

test('every registered namespace resolves through native-i18n in every locale', async () => {
  const namespaces = Object.keys(catalogs) as (keyof typeof catalogs)[];
  for (const locale of uiLocales) {
    const result = await i18n.getTranslation(namespaces as [keyof typeof catalogs], [locale]);
    expect(result.locale.current).toBe(locale);
    expect(Object.keys(result.t).sort()).toEqual([...namespaces].sort());
  }
});
