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

export async function prepareCatalogueRuntime(appRoot: string): Promise<void> {
  // Keep public exports and relative imports intact, including the shared request locale.
  // Strip the generated comments before either Vite graph parses the catalogue.
  const root = resolve(appRoot, catalogueParaglideOutput);
  const files = [...new Bun.Glob('**/*.js').scanSync({ cwd: root })];
  await Bun.build({
    root,
    entrypoints: files.map((file) => resolve(root, file)),
    outdir: resolve(appRoot, catalogueParaglideRuntime),
    external: ['*'],
    minify: { whitespace: true, syntax: true },
  });
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
