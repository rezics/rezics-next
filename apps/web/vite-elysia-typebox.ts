import type { Plugin } from 'vite';

const typeLoader = /(?:^|\/)elysia\/(?:dist|src)\/type\/typebox-type\.mjs$/u;
const valueLoader = /(?:^|\/)elysia\/(?:dist|src)\/type\/typebox-value\.mjs$/u;
const valueRequire = /(?:^|\/)elysia\/(?:dist|src)\/type\/typebox-value-require\.mjs$/u;

/**
 * Elysia 2 lazy-loads TypeBox through Node `require` / `createRequire`. Workerd has neither, and evaluating
 * those loaders throws `module is not defined`. Elysia's AOT TypeBox wiring swaps the lazy files for the
 * live ESM modules that import TypeBox statically; this plugin applies that swap in Vite serve as well as build.
 * CommonJS `.js` copies stay untouched: rewriting them emits `module.exports`, which workerd cannot evaluate.
 */
export function transformElysiaTypeboxLoader(_code: string, id: string): string | null {
  const file = id.split('?', 1)[0]!.replaceAll('\\', '/');
  if (file.endsWith('.js')) return null;
  if (typeLoader.test(file)) return "export * from './typebox-type-live.mjs';\n";
  if (valueLoader.test(file)) return "export * from './typebox-value-live.mjs';\n";
  if (valueRequire.test(file)) {
    return 'export const requireTypebox = () => undefined;\nexport const importTypebox = () => undefined;\n';
  }
  return null;
}

/** Statically bind TypeBox so the site Worker can load the installed client's Elysia schemas. */
export function elysiaWorkerdTypebox(): Plugin {
  return {
    name: 'elysia-workerd-typebox',
    enforce: 'pre',
    transform(code, id) {
      const transformed = transformElysiaTypeboxLoader(code, id);
      return transformed === null ? null : { code: transformed, map: null };
    },
  };
}
