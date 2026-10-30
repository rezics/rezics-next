import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import manifest from '../fixtures/definition-historical-construction.json';
import type { validateRelease } from '../../src/index.ts';

const root = resolve(import.meta.dir, '../../../..');
const definitionsPath = 'packages/definitions/src/index.ts';
const filterPath = 'packages/filter/src/filter.ts';
const publicationPath = 'services/kernel/src/semantic/definitions.ts';

/** Exact Git source bytes, not a reconstruction of old behavior. Unchanged
 * relative dependencies are checked against the same pin before any import.
 * The manifest makes this executable in archives without Git or network access.
 */
export function historicalConstructionSources(publication = false) {
  const result = new Map<string, string>();
  for (const file of manifest.files) {
    if (!publication && file.path.startsWith('services/')) continue;
    const source = readFileSync(resolve(root, file.snapshot ?? file.path), 'utf8');
    const sha256 = createHash('sha256').update(source).digest('hex');
    const gitBlob = createHash('sha1')
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest('hex');
    if (sha256 !== file.sha256 || gitBlob !== file.gitBlob)
      throw new Error(`Historical source identity mismatch: ${file.path}`);
    if ('snapshot' in file) result.set(resolve(root, file.path), source);
  }
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const pkg = JSON.parse(
      readFileSync(resolve(root, `packages/definitions/node_modules/${name}/package.json`), 'utf8'),
    );
    if (pkg.version !== version) throw new Error(`Historical dependency mismatch: ${name}@${pkg.version}`);
  }
  return result;
}

/** Materialize only the two changed modules to keep the oracle isolated from
 * already imported delivered modules. Only import locations change; the exact
 * original pattern, profile and schema files retain their own module locations.
 */
export async function originalValidator() {
  const pinned = historicalConstructionSources();
  const temporary = resolve(root, '.temp/publication-construction');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'oracle-'));
  try {
    const filter = join(directory, 'filter.ts');
    const definitions = join(directory, 'definitions.ts');
    for (const [path, target] of [
      [filterPath, filter],
      [definitionsPath, definitions],
    ]) {
      const origin = resolve(root, path!);
      const source = pinned.get(origin)!;
      writeFileSync(
        target!,
        source.replace(/from (['"])([^'"]+)\1/g, (match, quote: string, specifier: string) => {
          if (specifier.startsWith('node:')) return match;
          const dependency =
            specifier === '@rezics/filter'
              ? filter
              : specifier.startsWith('.')
                ? resolve(dirname(origin), specifier)
                : Bun.resolveSync(specifier, dirname(origin));
          return `from ${quote}${dependency}${quote}`;
        }),
      );
    }
    const original = (await import(definitions)) as { validateRelease: typeof validateRelease };
    return { validate: original.validateRelease, close: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Install before importing any kernel/core module, in the historical child
 * only. Keeping original module paths preserves relative imports and Reylo's SQL
 * loader. The delivered child never registers these hooks or shares its caches.
 */
export function mountHistoricalConstruction() {
  const pinned = historicalConstructionSources(true);
  const loaded: string[] = [];
  Bun.plugin({
    name: 'pinned-historical-construction',
    setup(build) {
      build.onLoad(
        {
          filter:
            /\/(?:packages\/(?:definitions\/src\/index|filter\/src\/filter)|services\/kernel\/src\/semantic\/definitions)\.ts$/,
        },
        ({ path }) => {
          const contents = pinned.get(path);
          if (contents === undefined) throw new Error(`Unexpected historical module: ${path}`);
          loaded.push(path.slice(root.length + 1));
          return { contents, loader: 'ts' };
        },
      );
    },
  });
  return { revision: manifest.revision, loaded, expected: [definitionsPath, filterPath, publicationPath].sort() };
}
