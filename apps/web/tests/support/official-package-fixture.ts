import { plugin } from 'bun';
import { readFileSync } from 'node:fs';

// Bun has no Vite glob. Load the real package reader with an empty installed
// table, so tests can preserve its exports rather than replace the whole module.
let loading = true;
plugin({
  name: 'official-package-fixture',
  setup(build) {
    build.onLoad({ filter: /\/apps\/web\/zones\/official\/index\.ts$/ }, ({ path }) => {
      if (!loading) return;
      return {
        contents: `import.meta.glob = () => ({});\n${readFileSync(path, 'utf8')}`,
        loader: 'ts',
      };
    });
  },
});
try {
  await import('../../zones/official/index.ts');
} finally {
  loading = false;
}
