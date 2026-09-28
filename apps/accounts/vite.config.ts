import { defineConfig } from 'vite';
import vinext from 'vinext';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { accountsSpec } from './features/config/env.ts';
import { browserDependencies } from './optimize-deps.ts';

// The dev AppHost passes origins as process variables; Workers read them as vars.
const names = Object.keys(accountsSpec);

export default defineConfig({
  optimizeDeps: { include: browserDependencies },
  plugins: [vinext({}), cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
    // Web, Accounts and every worktree's dev servers run at once; the default
    // inspector port 9229 made whichever started second crash. Opt in per run.
    inspectorPort: process.env.WORKER_INSPECTOR_PORT ? Number(process.env.WORKER_INSPECTOR_PORT) : false,
    config: config => ({ ...config, vars: { ...config.vars, ...Object.fromEntries(names
      .map(name => [name, process.env[name] ?? config.vars?.[name]])
      .filter(([, value]) => value !== undefined)) } }),
  }), tailwindcss()],
});
