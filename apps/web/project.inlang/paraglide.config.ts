import type { CompilerOptions } from '@inlang/paraglide-js';

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;

const config: Omit<CompilerOptions, 'project'> = {
  outdir: './src/paraglide',
  emitTsDeclarations: true,
  strategy: ['url', 'cookie', 'custom-accept-language', 'baseLocale'],
  cookieName: 'rezics_locale',
  urlPatterns: [
    { pattern: '/', localized: locales.map((locale) => [locale, `/${locale}`]) },
    { pattern: '/:path(.*)?', localized: locales.map((locale) => [locale, `/${locale}/:path(.*)?`]) },
  ],
};

export default config;
