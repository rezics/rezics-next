import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('dev message imports follow generated public exports for aliases and finite templates', () => {
  const result = Bun.spawnSync({
    cmd: [
      'node',
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
        import { resolve } from 'node:path';
        import { createServer } from 'vite';
        import { messageImports } from './scripts/message-imports.ts';

        const root = await mkdtemp(resolve('../../.temp/message-import-map-'));
        let server;
        const write = (path, source) => writeFile(resolve(root, 'src', path), source);
        const leaf = (id, value) =>
          'export const ' + id + ' = (inputs = {}, options = {}) => ' + JSON.stringify(value) + ' + (options.locale || "en");';
        try {
          await mkdir(resolve(root, 'src/paraglide/messages'), { recursive: true });
          await write('paraglide/messages.js', 'throw new Error("the full catalogue was loaded");');
          await write('paraglide/messages/_index.js', [
            "export * from './ordinary.js'",
            "export * from './knowledge_reference_documentid.js'",
            "export * from './knowledge_reference_documentid1.js'",
            "export * from './selection.js'",
          ].join('\\n'));
          await write('paraglide/messages/ordinary.js', leaf('ordinary_key', 'ordinary:'));
          await write('paraglide/messages/knowledge_reference_documentid.js',
            leaf('knowledge_reference_documentid', 'lower:'));
          await write('paraglide/messages/knowledge_reference_documentid1.js',
            leaf('knowledge_reference_documentid1', 'upper:') +
            '\\nexport { knowledge_reference_documentid1 as "knowledge_reference_documentId" }');
          await write('paraglide/messages/selection.js',
            leaf('selectionOne', 'one:') + '\\n' +
            leaf('selectionTwo', 'two:') + '\\n' +
            'export { selectionOne as "selection_one" }' + '\\n' +
            'export { selectionTwo as "selection_two" }');
          await write('visit.js', [
            "import { m } from './paraglide/messages.js';",
            'export const ordinary = (locale) => m.ordinary_key({}, { locale });',
            'export const lower = (locale) => m.knowledge_reference_documentid({}, { locale });',
            'export const upper = (locale) => m.knowledge_reference_documentId({}, { locale });',
            'export const selected = (name, locale) => m[' + String.fromCharCode(96) +
              'selection_' + String.fromCharCode(36) + '{name}' + String.fromCharCode(96) + ']({}, { locale });',
            "const density = { m: 'medium' }; export const medium = density.m;",
          ].join('\\n'));
          await write('namespace.js',
            "import { m } from './paraglide/messages.js'; export const carried = { m };");
          await write('unresolved.js',
            "import { m } from './paraglide/messages.js'; export const missing = m.not_generated;");

          server = await createServer({
            configFile: false, root, plugins: [messageImports(root)],
            server: { middlewareMode: true, watch: null, hmr: false },
            optimizeDeps: { noDiscovery: true, include: [] },
          });
          const transformed = await server.environments.ssr.transformRequest('/src/visit.js');
          assert.ok(transformed.code.includes('knowledge_reference_documentid1.js'));
          assert.ok(transformed.code.includes('knowledge_reference_documentId'));
          assert.equal((transformed.code.match(/selection\\.js/g) ?? []).length, 1,
            'matching exports share one import from their generated leaf');
          assert.ok(!transformed.code.includes('paraglide/messages.js'), 'ordinary calls avoid the full catalogue');
          const visit = await server.ssrLoadModule('/src/visit.js');
          assert.equal(visit.ordinary('de'), 'ordinary:de');
          assert.equal(visit.lower('fr'), 'lower:fr');
          assert.equal(visit.upper('ja'), 'upper:ja');
          assert.equal(visit.selected('one', 'de'), 'one:de');
          assert.equal(visit.selected('two', 'fr'), 'two:fr');
          assert.equal(visit.medium, 'medium', 'a property named m does not shadow the imported namespace');
          const namespace = await server.environments.ssr.transformRequest('/src/namespace.js');
          assert.ok(namespace.code.includes('paraglide/messages.js'), 'passing the namespace keeps the full barrel');
          const unresolved = await server.environments.ssr.transformRequest('/src/unresolved.js');
          assert.ok(unresolved.code.includes('paraglide/messages.js'), 'unresolved public IDs keep the full barrel');
        } finally {
          await server?.close();
          await rm(root, { recursive: true, force: true });
        }
      `,
    ],
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 55_000,
  });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}, 60_000);
