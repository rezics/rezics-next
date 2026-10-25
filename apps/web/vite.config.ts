import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ plugins: [tanstackStart(), tailwindcss(), ...cloudflare()] });
