import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import vinext from 'vinext';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { checkProductionEnv } from '../../scripts/ops/production-env.ts';

const app = fileURLToPath(new URL('.', import.meta.url));
const components = fileURLToPath(new URL('../../packages/ui/src/components/', import.meta.url));
const uiSource = '@source "../../../packages/ui/src";';

/** Source files Tailwind would scan in this app, less stories and tests. */
function appSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'dist', 'tests', '.storybook'].includes(entry.name) ? [] : appSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(stories|test)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The Rezics UI components the app imports, with the components they import in turn. */
export function usedUiComponents(): string[] {
  const used = new Set<string>();
  const visit = (name: string) => {
    if (used.has(name)) return;
    used.add(name);
    for (const match of readFileSync(join(components, `${name}.tsx`), 'utf8').matchAll(/from '\.\/([\w-]+)\.tsx'/g)) {
      visit(match[1]!);
    }
  };
  for (const file of appSources(app)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/['"]@rezics\/ui\/([\w-]+)['"]/g)) {
      if (match[1] !== 'utils' && match[1] !== 'styles') visit(match[1]!);
    }
  }
  return [...used].sort();
}

/**
 * Browser dependencies pre-bundled when the dev server starts. A dependency
 * Vite first meets on a later page (an Ark UI entry only the Library's dialogs
 * import) re-bundles them mid-session, and a page still holding the first
 * bundle's React then renders Ark's Presence with a second React ("Invalid
 * hook call"). Accounts and Storybook pre-bundle the same way.
 */
function browserDependencies(): string[] {
  const ark = usedUiComponents().flatMap(name => [...readFileSync(join(components, `${name}.tsx`), 'utf8')
    .matchAll(/from '(@ark-ui\/react(?:\/[\w-]+)?)'/g)].map(match => match[1]!));
  return [...new Set(ark)].sort().concat(['@tanstack/react-query', 'lucide-react', 'native-i18n', 'tailwind-variants']);
}

/**
 * Production CSS carries only the Rezics UI components the app uses. Tailwind
 * generates a rule for every class it finds in its sources, and scanning all of
 * packages/ui added a third to the render-blocking stylesheet for components no
 * page renders. Dev and Storybook keep app/styles.css as written and scan all.
 */
function usedUiSources(): Plugin {
  return { name: 'rezics:used-ui-sources', apply: 'build', enforce: 'pre',
    transform(code, id) {
      if (!id.startsWith(join(app, 'app/styles.css')) || !code.includes(uiSource)) return;
      return code.replace(uiSource, [
        '@source "../../../packages/ui/src/hooks";',
        ...usedUiComponents().map(name => `@source "../../../packages/ui/src/components/${name}.tsx";`),
      ].join('\n'));
    } };
}

export default defineConfig({
  optimizeDeps: { include: browserDependencies() },
  plugins: [usedUiSources(), vinext({}), cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
    // Web, Accounts and every worktree's dev servers run at once; the default
    // inspector port 9229 made whichever started second crash. Opt in per run.
    inspectorPort: process.env.WORKER_INSPECTOR_PORT ? Number(process.env.WORKER_INSPECTOR_PORT) : false,
    config: config => {
      const vars = { ...config.vars,
      MAIN_ORIGIN: process.env.MAIN_ORIGIN ?? config.vars?.MAIN_ORIGIN,
      ACCOUNT_ORIGIN: process.env.ACCOUNT_ORIGIN ?? config.vars?.ACCOUNT_ORIGIN,
      MAIN_RESOURCE: process.env.MAIN_RESOURCE ?? config.vars?.MAIN_RESOURCE,
      WEB_OAUTH_CLIENT_ID: process.env.WEB_OAUTH_CLIENT_ID ?? config.vars?.WEB_OAUTH_CLIENT_ID,
      };
      if (config.name === 'rezics-web-production' || process.env.CLOUDFLARE_ENV === 'production') {
        checkProductionEnv(Object.fromEntries(Object.entries(vars).map(([name, value]) =>
          [name, typeof value === 'string' ? value : value === undefined ? undefined : JSON.stringify(value)])), ['web']);
      }
      return { ...config, vars };
    },
  }),
    tailwindcss()],
});
