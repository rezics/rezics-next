import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { Plugin } from 'vite';

type Docgen = { actualName?: string; definedInFile?: string } & Record<string, unknown>;
type ComponentManifest = { components: Record<string, { reactDocgen?: Docgen }> };

async function readManifest(file: string): Promise<ComponentManifest> {
  // Storybook writes its manifest and builds the preview concurrently.
  const deadline = Date.now() + 600_000;
  while (true) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as ComponentManifest;
    } catch (error) {
      if (
        Date.now() >= deadline ||
        (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
      )
        throw error;
      await setTimeout(250);
    }
  }
}

/** Reuse the selected components' published props for browser Controls and Docs. */
export function staticDocgen(output: string): Plugin {
  const byFile = new Map<string, Map<string, Record<string, unknown>>>();
  return {
    name: 'rezics:storybook-static-docgen',
    enforce: 'pre',
    async buildStart() {
      const manifest = await readManifest(resolve(output, 'manifests/components.json'));
      for (const { reactDocgen } of Object.values(manifest.components)) {
        if (!reactDocgen) continue;
        const { actualName, definedInFile, ...docs } = reactDocgen;
        if (!definedInFile || !actualName || !/^[$A-Z_a-z][$\w]*$/.test(actualName)) continue;
        const exports = byFile.get(definedInFile) ?? new Map();
        exports.set(actualName, docs);
        byFile.set(definedInFile, exports);
      }
    },
    transform(source, id) {
      const entries = byFile.get(id);
      if (!entries) return;
      const annotations = Array.from(
        entries,
        ([name, docs]) =>
          `if (typeof ${name} === 'function' || (typeof ${name} === 'object' && ${name} !== null)) ${name}.__docgenInfo = ${JSON.stringify(docs)};`,
      );
      return { code: `${source}\n${annotations.join('\n')}\n`, map: null };
    },
  };
}
