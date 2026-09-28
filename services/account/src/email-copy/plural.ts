/** `{n}` is the locale’s decimal form of `count`. `one` is used only when
 * `Intl.PluralRules` selects `one`; every other category uses `other`. */
export function plural(locale: string, count: number, forms: { one?: string; other: string }): string {
  const category = new Intl.PluralRules(locale).select(count);
  const template = category === 'one' && forms.one ? forms.one : forms.other;
  return template.replaceAll('{n}', new Intl.NumberFormat(locale).format(count));
}
