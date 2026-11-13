import type { Plugin } from 'vite';

/** Resolves installed selector CommonJS shims to the Web ESM adapter in every Vite environment. */
export function clientModuleSelectorEsm(specifier: string, adapterPath: string): Plugin {
  const adapterUrl = adapterPath.replace(/\\/g, '/');
  return {
    name: 'web-selector-esm',
    enforce: 'pre',
    resolveId(id) {
      if (id === specifier || id === `${specifier}.js`) return adapterPath;
      return null;
    },
    load(id) {
      const path = (id.split('?')[0] ?? id).replace(/\\/g, '/');
      if (path.endsWith('/use-sync-external-store/shim/index.js'))
        return { code: "export { useSyncExternalStore } from 'react';\n", map: null };
      if (path.endsWith('/use-sync-external-store/shim/with-selector.js'))
        return { code: `export * from ${JSON.stringify(adapterUrl)};\n`, map: null };
      return null;
    },
  };
}
