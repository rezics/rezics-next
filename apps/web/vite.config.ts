import { defineConfig } from 'vite';
import vinext from 'vinext';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vinext({}), cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
    // Web, Accounts and every worktree's dev servers run at once; the default
    // inspector port 9229 made whichever started second crash. Opt in per run.
    inspectorPort: process.env.WORKER_INSPECTOR_PORT ? Number(process.env.WORKER_INSPECTOR_PORT) : false,
    config: config => ({ ...config, vars: { ...config.vars,
      MAIN_ORIGIN: process.env.MAIN_ORIGIN ?? config.vars?.MAIN_ORIGIN,
      ACCOUNT_ORIGIN: process.env.ACCOUNT_ORIGIN ?? config.vars?.ACCOUNT_ORIGIN,
      MAIN_RESOURCE: process.env.MAIN_RESOURCE ?? config.vars?.MAIN_RESOURCE,
      WEB_OAUTH_CLIENT_ID: process.env.WEB_OAUTH_CLIENT_ID ?? config.vars?.WEB_OAUTH_CLIENT_ID,
    } }),
  }),
    tailwindcss()],
});
