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
    config: config => ({ ...config, vars: { ...config.vars, ...Object.fromEntries(names
      .map(name => [name, process.env[name] ?? config.vars?.[name]])
      .filter(([, value]) => value !== undefined)) } }),
  }), tailwindcss()],
});
