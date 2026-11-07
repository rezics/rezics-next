import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const typeLoader = /(?:^|\/)elysia\/(?:dist|src)\/type\/typebox-type\.(?:mjs|js)$/u;
const valueLoader = /(?:^|\/)elysia\/(?:dist|src)\/type\/typebox-value\.(?:mjs|js)$/u;
const valueRequire = /(?:^|\/)elysia\/(?:dist|src)\/type\/typebox-value-require\.(?:mjs|js)$/u;
const familySpecifier = /^(elysia|@elysia\/eden)(?:\/.*)?$/u;
const defaultFromFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/client/package.json');

type PackageExports = Record<string, string | { import?: unknown; default?: unknown } | undefined>;

function packageNameOf(id: string): string | undefined {
  if (id === 'elysia' || id.startsWith('elysia/')) return 'elysia';
  if (id === '@elysia/eden' || id.startsWith('@elysia/eden/')) return '@elysia/eden';
  return undefined;
}

function importTarget(entry: PackageExports[string]): string | undefined {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return undefined;
  if (typeof entry.import === 'string') return entry.import;
  if (entry.import && typeof entry.import === 'object' && 'default' in entry.import) {
    const nested = (entry.import as { default?: unknown }).default;
    if (typeof nested === 'string') return nested;
  }
  if (typeof entry.default === 'string') return entry.default;
  return undefined;
}

/**
 * Worker resolve conditions omit `import`, so Vite would load Elysia/Eden `exports.require` / `main` CJS into
 * workerd and throw `module is not defined`. Map those specifiers onto their `exports.import` files instead.
 */
export function resolveElysiaFamilyImport(id: string, fromFile: string): string | null {
  if (!familySpecifier.test(id)) return null;
  const name = packageNameOf(id);
  if (!name) return null;
  const require = createRequire(fromFile);
  const pkgRoot = dirname(require.resolve(`${name}/package.json`));
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { exports?: PackageExports };
  const subpath = id === name ? '.' : `./${id.slice(name.length + 1)}`;
  const target = importTarget(pkg.exports?.[subpath]);
  if (!target) return null;
  const file = join(pkgRoot, target);
  if (!existsSync(file)) return null;
  return realpathSync(file);
}

/**
 * Elysia 2 lazy-loads TypeBox through Node `require` / `createRequire`. Workerd has neither, and evaluating
 * those loaders throws `module is not defined`. Elysia's AOT TypeBox wiring swaps the lazy files for the
 * live ESM modules that import TypeBox statically; this plugin applies that swap in Vite serve as well as build.
 * CommonJS `.js` copies are rewritten to the same ESM live files so workerd never evaluates `module.exports`.
 */
export function transformElysiaTypeboxLoader(_code: string, id: string): string | null {
  const file = id.split('?', 1)[0]!.replaceAll('\\', '/');
  if (typeLoader.test(file)) return "export * from './typebox-type-live.mjs';\n";
  if (valueLoader.test(file)) return "export * from './typebox-value-live.mjs';\n";
  if (valueRequire.test(file)) {
    return 'export const requireTypebox = () => undefined;\nexport const importTypebox = () => undefined;\n';
  }
  return null;
}

/** Statically bind TypeBox and force Elysia/Eden ESM so the site Worker can load installed client schemas. */
export function elysiaWorkerdTypebox(fromFile = defaultFromFile): Plugin {
  return {
    name: 'elysia-workerd-typebox',
    enforce: 'pre',
    resolveId(id) {
      return resolveElysiaFamilyImport(id, fromFile);
    },
    transform(code, id) {
      const transformed = transformElysiaTypeboxLoader(code, id);
      return transformed === null ? null : { code: transformed, map: null };
    },
  };
}
