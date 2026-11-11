import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import manifest from '../fixtures/definition-historical-construction.json';
import type { validateRelease } from '../../src/index.ts';

const root = resolve(import.meta.dir, '../../../..');
const definitionsPath = 'packages/definitions/src/index.ts';
const filterPath = 'packages/filter/src/filter.ts';
const publicationPath = 'services/kernel/src/semantic/definitions.ts';
const historicalDependencyAliases = { recheck: 'recheck-historical' };

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
    const installedName = historicalDependencyAliases[name as keyof typeof historicalDependencyAliases] ?? name;
    const pkg = JSON.parse(
      readFileSync(resolve(root, `packages/definitions/node_modules/${installedName}/package.json`), 'utf8'),
    );
    if (pkg.version !== version) throw new Error(`Historical dependency mismatch: ${name}@${pkg.version}`);
  }
  return result;
}

/** Reuse the same verified old dependency graph for pure and instrumented comparisons. */
export function materializeHistoricalConstruction(directory: string, publication = false) {
  const pinned = historicalConstructionSources(publication);
  const targets = new Map(
    [...pinned.keys()].map((origin, index) => [
      origin,
      join(directory, `module-${index}${origin.endsWith('.json') ? '.json' : '.ts'}`),
    ]),
  );
  for (const [origin, source] of pinned) {
    const target = targets.get(origin)!;
    writeFileSync(
      target,
      origin.endsWith('.json')
        ? source
        : source.replace(/from (['"])([^'"]+)\1/g, (match, quote: string, specifier: string) => {
            if (specifier.startsWith('node:')) return match;
            const dependency =
              specifier === '@rezics/filter'
                ? resolve(root, filterPath)
                : specifier.startsWith('.')
                  ? resolve(dirname(origin), specifier)
                  : Bun.resolveSync(
                      specifier === 'recheck' || specifier.startsWith('recheck/')
                        ? `${historicalDependencyAliases.recheck}${specifier.slice('recheck'.length)}`
                        : specifier,
                      dirname(origin),
                    );
            return `from ${quote}${targets.get(dependency) ?? dependency}${quote}`;
          }),
    );
  }
  return targets;
}

/** Materialize changed modules and their pinned dependencies in an isolated old
 * graph. Import rewrites point at exact verified snapshots, never current schema.
 */
export async function originalValidator() {
  const temporary = resolve(root, '.temp/publication-construction');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'oracle-'));
  try {
    const targets = materializeHistoricalConstruction(directory);
    const original = (await import(targets.get(resolve(root, definitionsPath))!)) as {
      validateRelease: typeof validateRelease;
    };
    return { validate: original.validateRelease, close: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Materialize the pinned publisher as a separate graph before importing the
 * current kernel. Only the historical definition route points into that graph;
 * current imports keep their live identities and module cache.
 */
export function mountHistoricalConstruction() {
  const temporary = resolve(root, '.temp/publication-construction');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'historical-'));
  let targets: Map<string, string>;
  try {
    targets = materializeHistoricalConstruction(directory, true);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const loaded: string[] = [];
  const traced = [definitionsPath, filterPath, publicationPath].map((relative) => {
    const origin = resolve(root, relative);
    const target = targets.get(origin);
    if (!target) throw new Error(`Missing historical module target: ${relative}`);
    return [resolve(target), relative] as const;
  });
  const tracedOrigins = new Map(traced);
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tracedFilter = new RegExp(`^(?:${traced.map(([target]) => escapeRegExp(target)).join('|')})$`);
  const routePath = resolve(root, 'services/kernel/src/semantic/http/definitions.ts');
  const routeFilter = new RegExp(`^${escapeRegExp(routePath)}$`);
  const publisherPath = targets.get(resolve(root, publicationPath))!;
  const originalDefinitionsPath = targets.get(resolve(root, definitionsPath))!;
  Bun.plugin({
    name: 'pinned-historical-construction',
    setup(build) {
      build.onLoad({ filter: tracedFilter }, ({ path }) => {
        const origin = tracedOrigins.get(resolve(path));
        if (!origin) throw new Error(`Unexpected historical module: ${path}`);
        loaded.push(origin);
        return { contents: readFileSync(path, 'utf8'), loader: 'ts' };
      });
      build.onLoad({ filter: routeFilter }, ({ path }) => {
        const contents = readFileSync(path, 'utf8');
        const importPath = "from '../definitions.ts'";
        if (contents.split(importPath).length !== 2)
          throw new Error(`Expected one definition publisher import in ${path}`);
        return {
          contents: contents.replace(importPath, `from ${JSON.stringify(publisherPath)}`),
          loader: 'ts',
        };
      });
    },
  });
  return {
    revision: manifest.revision,
    loaded,
    expected: [definitionsPath, filterPath, publicationPath].sort(),
    originalDefinitionsPath,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
