import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
export default defineConfig({ optimizeDeps: { include: ['@ark-ui/react', '@ark-ui/react/menu', '@ark-ui/react/select', '@ark-ui/react/dialog', '@ark-ui/react/locale', 'lucide-react', '@rezics/ui/menu', '@rezics/ui/select', '@rezics/ui/button'] }, plugins: [paraglideVitePlugin({ project: './project.inlang' }), tanstackStart(), react(), tailwindcss(), ...cloudflare({ viteEnvironment: { name: 'ssr' } })] });
