import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
export default defineConfig({ plugins: [paraglideVitePlugin({ project: './project.inlang' }), tanstackStart(), tailwindcss(), ...cloudflare({ viteEnvironment: { name: 'ssr' } })] });
