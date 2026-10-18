import { mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = process.cwd();
const source = resolve('scripts/research/frontend-hotkeys');
const base = resolve('.temp/frontend-hotkeys');
const trial = join(base, 'trial');
mkdirSync(trial, { recursive: true });
writeFileSync(join(trial, 'package.json'), readFileSync(join(source, 'trial-package.json')));
writeFileSync(join(trial, '.yarnrc.yml'), `nodeLinker: node-modules
enableScripts: false
# Exact versions explicitly authorized for this isolated experiment, released
# less than Yarn's default 1440 minutes ago. No production configuration changes.
npmPreapprovedPackages:
  - "@tanstack/react-hotkeys@0.15.0"
  - "@tanstack/hotkeys@0.16.0"
`);
if (!existsSync(join(trial, 'yarn.lock'))) writeFileSync(join(trial, 'yarn.lock'), '');
const fixture = join(base, 'fixture');
mkdirSync(join(fixture, 'app/second'), { recursive: true });
writeFileSync(join(fixture, 'package.json'), '{"name":"keyboard-fixture","private":true,"type":"module"}\n');
writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', module: 'ESNext', moduleResolution: 'Bundler' } }));
if (!existsSync(join(fixture, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'));
writeFileSync(join(fixture, 'app/layout.tsx'), `import './styles.css';
export default function Layout({ children }) { return <html lang="en"><body>{children}</body></html> }\n`);
writeFileSync(join(fixture, 'app/page.tsx'), `export { default } from '${source}/fixture.tsx';\n`);
writeFileSync(join(fixture, 'app/second/page.tsx'), `export { default } from '${source}/fixture.tsx';\n`);
writeFileSync(join(fixture, 'app/styles.css'), `@import "${root}/apps/web/app/styles.css";
@source "${source}";
input:not([type=checkbox]), textarea, select { border:1px solid #767676; border-radius:6px; padding:8px; display:block; max-width:100%; }
button { padding:8px 12px; border:1px solid #767676; border-radius:6px; }
:focus-visible { outline:3px solid #1b62d1; outline-offset:3px; }
fieldset { border:1px solid #767676; padding:12px; display:grid; gap:8px; }
`);
writeFileSync(join(fixture, 'vite.config.ts'), `import { defineConfig } from 'vite';
import vinext from 'vinext';
import tailwindcss from '@tailwindcss/vite';
const candidate = process.env.HOTKEY_CANDIDATE ?? 'native';
export default defineConfig({
 plugins: [vinext({}), tailwindcss()],
 resolve: { dedupe: ['react','react-dom'], alias: {
  'virtual:hotkey-adapter': '${source}/adapter-' + candidate + '.tsx',
  'virtual:native-owners': '${source}/native-' + (candidate === 'native-as-is' ? 'owners' : 'empty') + '.tsx',
  '@tanstack/react-hotkeys': '${trial}/node_modules/@tanstack/react-hotkeys/dist/index.js',
 } },
 define: { __CANDIDATE__: JSON.stringify(candidate) },
 server: { fs: { allow: ['${root}'] } },
});\n`);
console.log(`Prepared ${fixture}; install only ${trial} with Yarn before behavior checks.`);
