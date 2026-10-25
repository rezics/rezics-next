import type { CompilerOptions } from '@inlang/paraglide-js';

const config: Omit<CompilerOptions, 'project'> = {
  outdir: './src/paraglide',
  emitTsDeclarations: true,
  strategy: ['cookie', 'custom-accept-language', 'baseLocale'],
  cookieName: 'rezics_locale',
};

export default config;
