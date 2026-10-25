import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare, getLocalWorkerdCompatibilityDate } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : '/auth-assets/',
  server: { cors: false },
  define: {
    __AUTH_ORIGIN__: JSON.stringify(command === 'serve' ? (process.env.AUTH_ORIGIN ?? '') : ''),
  },
  plugins: [
    paraglideVitePlugin({ project: './project.inlang' }),
    tanstackStart(),
    react(),
    tailwindcss(),
    ...cloudflare({
      viteEnvironment: { name: 'ssr' },
      ...(command === 'serve' ? { config: { compatibilityDate: getLocalWorkerdCompatibilityDate().date } } : {}),
    }),
  ],
}));
