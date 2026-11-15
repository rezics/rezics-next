import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

// Two production entries share the message barrel. Each entry's eager graph keeps every locale of
// its own message and omits the other entry's copy. Calling the built entry selects the locale.
// Inlang reads ./messages from the parent of project.inlang. Non-library Vite builds drop an
// entry export that nothing calls, so the fixture keeps those exports strict and then calls them.
test('a production entry omits unrelated message copy', () => {
  const result = Bun.spawnSync({
    cmd: ['node', '--input-type=module', '-e', fixture],
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
    env: { ...process.env, NODE_ENV: 'production' },
  });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}, 60_000);

const fixture = String.raw`
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(resolve('package.json'));
const plugin = require.resolve('@inlang/plugin-json');
const repository = resolve('..', '..');
mkdirSync(join(repository, '.temp'), { recursive: true });
const root = mkdtempSync(join(repository, '.temp', 'message-bundle-'));
try {
  const project = join(root, 'project.inlang');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, 'messages'), { recursive: true });
  writeFileSync(join(project, 'settings.json'), JSON.stringify({
    $schema: 'https://inlang.com/schema/project-settings',
    baseLocale: 'en',
    locales: ['en', 'de'],
    modules: [plugin],
    'plugin.inlang.json': { pathPattern: './messages/{locale}.json' },
  }));
  writeFileSync(join(root, 'messages/en.json'), JSON.stringify({
    route_label: 'Kept route label',
    other_domain: 'SENTINEL_OTHER_DOMAIN_EN',
  }));
  writeFileSync(join(root, 'messages/de.json'), JSON.stringify({
    route_label: 'Behaltene Routenbeschriftung',
    other_domain: 'SENTINEL_OTHER_DOMAIN_DE',
  }));
  const { compile } = await import('@inlang/paraglide-js');
  const outdir = join(root, 'src/paraglide');
  await compile({
    project,
    outdir,
    outputStructure: 'message-modules',
    strategy: ['cookie', 'baseLocale'],
    cookieName: 'rezics_locale',
    emitTsDeclarations: false,
    emitGitIgnore: false,
    emitPrettierIgnore: false,
    emitReadme: false,
  });
  writeFileSync(join(root, 'src/entry-a.js'), "import { m } from './paraglide/messages.js';\nexport const label = (locale) => m.route_label({}, locale ? { locale } : {});\n");
  writeFileSync(join(root, 'src/entry-b.js'), "import { m } from './paraglide/messages.js';\nexport const other = (locale) => m.other_domain({}, locale ? { locale } : {});\n");
  const { build } = await import('vite');
  await build({
    configFile: false,
    root,
    appType: 'custom',
    logLevel: 'error',
    build: {
      outDir: 'dist',
      minify: false,
      emptyOutDir: true,
      modulePreload: false,
      copyPublicDir: false,
      rolldownOptions: {
        preserveEntrySignatures: 'strict',
        input: { a: join(root, 'src/entry-a.js'), b: join(root, 'src/entry-b.js') },
        output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name].js' },
      },
    },
  });
  const routeEntry = findEntry(join(root, 'dist'), 'a.js');
  const otherEntry = findEntry(join(root, 'dist'), 'b.js');
  const route = eager(routeEntry);
  const other = eager(otherEntry);
  for (const text of ['Kept route label', 'Behaltene Routenbeschriftung']) {
    if (!route.includes(text)) throw new Error('missing from the route graph: ' + text);
  }
  if (route.includes('SENTINEL_OTHER_DOMAIN')) throw new Error('unrelated message copy is in the route graph');
  if (!other.includes('SENTINEL_OTHER_DOMAIN_EN') || !other.includes('SENTINEL_OTHER_DOMAIN_DE')) {
    throw new Error('the other entry lost its own locale copy');
  }
  if (other.includes('Kept route label') || other.includes('Behaltene Routenbeschriftung')) {
    throw new Error('route copy leaked into the other entry');
  }
  const routeModule = await import(pathToFileURL(routeEntry).href);
  const otherModule = await import(pathToFileURL(otherEntry).href);
  if (routeModule.label() !== 'Kept route label' || routeModule.label('de') !== 'Behaltene Routenbeschriftung') {
    throw new Error('route entry did not resolve both locales at runtime');
  }
  if (otherModule.other() !== 'SENTINEL_OTHER_DOMAIN_EN' || otherModule.other('de') !== 'SENTINEL_OTHER_DOMAIN_DE') {
    throw new Error('the other entry did not resolve both locales at runtime');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

function findEntry(dir, name) {
  const hits = [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        files.push(path);
        if (entry.name === name) hits.push(path);
      }
    }
  };
  walk(dir);
  if (hits.length !== 1) {
    throw new Error('expected one ' + name + ', found ' + (hits.join(', ') || 'none') + '; files ' + files.join(', '));
  }
  return hits[0];
}

function eager(entry) {
  const seen = new Set();
  let code = '';
  const visit = (file) => {
    const absolute = resolve(file);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const source = readFileSync(absolute, 'utf8');
    code += '\n' + source;
    const directory = dirname(absolute);
    for (const specifier of staticSpecifiers(source)) {
      let target = resolve(directory, specifier);
      if (!target.endsWith('.js')) target += '.js';
      visit(target);
    }
  };
  visit(entry);
  return code;
}

function staticSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const specifiers = [];
  const pattern = /(?:^|[^\w$])(?:import|export)\s*(?:[^'"()\n]*\bfrom\s*)?(['"])(\.[^'"]+)\1/g;
  for (const match of code.matchAll(pattern)) {
    if (match[0].includes('import(')) continue;
    specifiers.push(match[2]);
  }
  return specifiers;
}
`;
