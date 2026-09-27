/** Interface locales. English is the fallback and the authoring contract. */
export const uiLocales = ['en', 'zh-CN'] as const;
export type UiLocale = (typeof uiLocales)[number];

/**
 * A feature's interface strings. English defines the shape; every other locale
 * must provide the same keys with the same recipe types (`insert`, `plural`).
 * Export the result as `messages` from `features/<name>/messages.ts` and add one
 * line for it to `i18n/catalogs.ts`.
 */
export function defineMessages<T extends object>(catalog: { en: T } & {
  [Locale in Exclude<UiLocale, 'en'>]: NoInfer<T> }): Record<UiLocale, T> {
  return catalog;
}
