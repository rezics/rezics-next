import type { CompilerOptions } from '@inlang/paraglide-js';

const config: Omit<CompilerOptions, 'project'> = {
  outdir: './src/paraglide',
  // One module per message, marked side-effect free, so an entry keeps only the messages it calls.
  outputStructure: 'message-modules',
  emitTsDeclarations: true,
  strategy: ['cookie', 'custom-accept-language', 'baseLocale'],
  cookieName: 'rezics_locale',
};

export default config;
