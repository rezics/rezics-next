import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Generated catalogues have no authored JavaScript to map back to. */
export function generatedMessageSourceMaps(appRoot: string): Plugin {
  const entry = resolve(appRoot, 'src/paraglide/messages.js').replaceAll('\\', '/');
  const directory = resolve(appRoot, 'src/paraglide/messages').replaceAll('\\', '/') + '/';
  return {
    name: 'generated-message-source-maps',
    apply: 'serve',
    enforce: 'post',
    applyToEnvironment(environment) {
      return environment.name !== 'client';
    },
    transform(code, id) {
      const file = id.split('?', 1)[0]!.replaceAll('\\', '/');
      if (file !== entry && !(file.startsWith(directory) && file.endsWith('.js'))) return;
      // An explicit empty map tells Vite's module runner not to construct another map during SSR rewriting.
      // `map: null` instead asks it to map every generated dispatch function and every locale function.
      // Vite drops transform maps when the returned code equals the loaded source. A trailing newline makes
      // this map-only transform observable without changing the generated module's exports or execution.
      return { code: code + '\n', map: { version: 3, names: [], sources: [], mappings: '' } };
    },
  };
}
