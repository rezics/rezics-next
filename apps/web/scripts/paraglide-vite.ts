import { dirname, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export const catalogueLocaleModules = 'REZICS_WEB_CATALOGUE_LOCALE_MODULES';
const catalogueParaglideOutput = './.temp/catalogue-paraglide';
export const catalogueParaglideRuntime = './.temp/catalogue-paraglide-runtime';

export function paraglideViteOptions(compact: boolean) {
  return {
    project: './project.inlang',
    outputStructure: compact ? ('locale-modules' as const) : ('message-modules' as const),
    ...(compact ? { outdir: catalogueParaglideOutput, emitTsDeclarations: false } : {}),
  };
}

/** Resolve app imports to the same generated runtime from both Vite environments. */
export function catalogueParaglideImports(appRoot: string): Plugin {
  const source = resolve(appRoot, 'src/paraglide');
  const output = resolve(appRoot, catalogueParaglideRuntime);
  return {
    name: 'catalogue-paraglide-imports',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!importer || !id.startsWith('.') || !id.includes('/paraglide/')) return;
      const path = resolve(dirname(importer), id);
      if (path.startsWith(source + sep))
        return this.resolve(output + path.slice(source.length), importer, { skipSelf: true });
    },
  };
}
