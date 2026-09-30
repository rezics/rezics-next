import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { aboutDevServer } from './dev-server.ts';
import { checkProductionEnv } from '../../scripts/ops/production-env.ts';

// The public origin canonical URLs, hreflang alternates and the sitemap use.
const site = process.env.ABOUT_SITE_URL ?? 'https://rezics.com';
if (process.env.CLOUDFLARE_ENV === 'production') checkProductionEnv({ ABOUT_SITE_URL: process.env.ABOUT_SITE_URL }, ['about']);

export default defineConfig({
  site,
  // A Worker with static assets serves dist/; pages are `<path>/index.html`.
  output: 'static',
  // Pages are directories (`/en/reading/`); the Worker's asset handling adds the slash in
  // production, so the dev server must not redirect `/api/notify` and `/trust` away first.
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  integrations: [react()],
  devToolbar: { enabled: false },
  server: { host: '127.0.0.1', port: 4321 },
  vite: { plugins: [tailwindcss(), aboutDevServer()] },
});
