import { defineConfig } from 'vite';
import vinext from 'vinext';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vinext({}), cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
    config: config => ({ ...config, vars: { ...config.vars,
      MAIN_ORIGIN: process.env.MAIN_ORIGIN ?? config.vars?.MAIN_ORIGIN,
      ACCOUNT_ORIGIN: process.env.ACCOUNT_ORIGIN ?? config.vars?.ACCOUNT_ORIGIN,
      MAIN_RESOURCE: process.env.MAIN_RESOURCE ?? config.vars?.MAIN_RESOURCE,
    } }),
  }),
    tailwindcss()],
});
