import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpus, platform, release, arch } from 'node:os';

const root = process.cwd();
const base = resolve('.temp/frontend-hotkeys');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const artifact = path => ({ path: relative(root, path), bytes: statSync(path).size, sha256: sha256(readFileSync(path)) });
const trial = join(base, 'trial/node_modules');
const installed = join(root, 'node_modules');
const closure = {};
function inventory(name, parent, allDependencies = true) {
  let directory = join(parent, name);
  if (!existsSync(join(directory, 'package.json'))) directory = join(installed, name);
  const path = join(directory, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const key = `${name}@${pkg.version}`;
  if (closure[key]) return;
  closure[key] = { name, version: pkg.version, license: pkg.license,
    dependencies: pkg.dependencies ?? {}, peerDependencies: pkg.peerDependencies ?? {},
    manifest: artifact(path), notices: readdirSync(directory).filter(file => /^licen[sc]e(?:\.|$)/i.test(file)).map(file => artifact(join(directory, file))) };
  if (allDependencies) for (const dep of Object.keys(pkg.dependencies ?? {})) inventory(dep, parent);
}
for (const name of ['@tanstack/react-hotkeys', 'react', 'react-dom']) inventory(name, trial);
inventory('@zag-js/hotkeys', installed);
// Ark's public umbrella has many unrelated widget dependencies; retain its full
// manifest, but inventory the hotkeys entry's closure separately above.
inventory('@ark-ui/react', installed, false);
const files = [];
function walk(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(?:png|html|log|json|md)$/.test(entry.name) || entry.name.endsWith('license')) files.push(artifact(path));
  }
}
for (const name of ['captures','primary','previous-measurement']) walk(join(base,name));
// Retain client/server module maps and actual loaded bytes, not entire output
// trees or tarball sizes as substitutes for route transfer measurements.
for (const entry of readdirSync(join(base,'route-captures'),{withFileTypes:true})) {
  const path=join(base,'route-captures',entry.name);
  if (!entry.isDirectory()) files.push(artifact(path));
  else for (const sub of ['client','server','server/ssr']) {
    const map=join(path,sub,'keyboard-module-closure.json');if(existsSync(map)) files.push(artifact(map));
  }
}
for (const name of ['behavior.json','routes.json','trial/package.json','trial/.yarnrc.yml','trial/yarn.lock']) files.push(artifact(join(base,name)));
const sources = {};
for (const path of ['yarn.lock','package.json','apps/web/vite.config.ts','apps/accounts/vite.config.ts',
  'apps/web/features/shell/search-field.tsx','apps/accounts/features/admin/shell/keys.ts',
  'apps/accounts/features/admin/shell/admin-shell.tsx','packages/ui/src/components/sidebar.tsx',
  'packages/ui/src/components/rich-text-editor.tsx','packages/ui/src/components/dialog.tsx',
  'packages/ui/src/hooks/use-dialog-behavior.ts','docs/goals/product-completion-20261019/library-research.json']) {
  if (existsSync(path)) sources[path]=artifact(resolve(path));
}
const result={capturedAt:new Date().toISOString(),revision:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),
  device:{os:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,node:process.version,
    bun:spawnSync('bun',['--version'],{encoding:'utf8'}).stdout.trim(),yarn:spawnSync('yarn',['--version'],{encoding:'utf8'}).stdout.trim()},
  closure,sources,artifacts:files.sort((a,b)=>a.path.localeCompare(b.path))};
mkdirSync(base,{recursive:true});writeFileSync(join(base,'evidence.json'),JSON.stringify(result,null,2)+'\n');
console.log(`${Object.keys(closure).length} exact packages; ${files.length} capture references`);
