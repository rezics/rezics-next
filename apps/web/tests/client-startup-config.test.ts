import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('installed serve composition discovers client dependencies on visits without crawling the server entry', () => {
  // Resolve under Node, like the installed Vite CLI. The unmerged app configuration cannot reveal entries added
  // by TanStack and Cloudflare's environment hooks. No server, compiler or native service is started here.
  const result = Bun.spawnSync({
    cmd: [
      'node',
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
        import { resolve } from 'node:path';
        import { createServer, resolveConfig } from 'vite';
        import { tanstackRouter } from '@tanstack/router-plugin/vite';
        import { messageImports } from './scripts/message-imports.ts';
        import { generatedMessageSourceMaps } from './scripts/generated-message-source-maps.ts';
        delete process.env.REZICS_TEST_RUNTIME;
        delete process.env.REZICS_WALK_STACK_SLOT;
        const config = await resolveConfig({ logLevel: 'silent' }, 'serve', 'development');
        for (const [name, options] of [
          ['root', config.optimizeDeps],
          ['client', config.environments.client.optimizeDeps],
        ]) {
          assert.deepEqual(options.entries, [], name + ': no startup source crawl');
          assert.equal(options.holdUntilCrawlEnd, false, name + ': on-demand discovery');
          assert.notEqual(options.noDiscovery, true, name + ': discovery remains enabled');
        }
        const worker = config.environments.ssr.optimizeDeps;
        assert.deepEqual(worker.entries, []);
        assert.equal(worker.noDiscovery, true);
        assert.ok(worker.include.includes('react-dom/server.edge'));
        assert.ok(worker.include.includes('typebox/type'));
        assert.ok(worker.include.includes('lucide-react'));
        assert.ok(worker.include.includes('@base-ui/react/*'));
        const routes = await createServer({
          configFile: false, logLevel: 'silent',
          plugins: [messageImports(process.cwd()), tanstackRouter({
            autoCodeSplitting: true,
            codeSplittingOptions: { defaultBehavior: [['loader'], ['component'], ['pendingComponent'], ['errorComponent'], ['notFoundComponent']] },
          })],
          server: { middlewareMode: true, watch: null, hmr: false },
          optimizeDeps: { noDiscovery: true, include: [] },
        });
        try {
          for (const [file, view] of [
            ['index', '/routes/-home'],
            ['editions/new', '/content-editions/edition-create-route'],
            ['editions/index', '/content-editions/creator-editions-route'],
            ['editions/$id', '/content-editions/edition-route'],
          ]) {
            const path = '/src/routes/' + file + '.tsx';
            const reference = await routes.environments.ssr.transformRequest(path);
            assert.ok(reference.code.includes('lazyRouteComponent'), file + ': visited component is lazy');
            assert.ok(!reference.code.includes(view), file + ': discovery does not load the view');
            const visited = await routes.environments.ssr.transformRequest(path + '?tsr-split=component');
            assert.ok(visited.code.includes(view), file + ': visiting loads the unchanged view');
          }
          const rules = await routes.environments.ssr.transformRequest('/src/community/realm-rules-authoring/panel.tsx');
          assert.ok(rules.code.includes('/paraglide/messages/realm_rules_authoring_open.js'));
          assert.ok(!rules.code.includes('/paraglide/messages.js'), 'rules labels do not load the full catalogue');
        } finally { await routes.close(); }
        const root = await mkdtemp(resolve('../../.temp/generated-message-map-'));
        await mkdir(resolve(root, 'src/paraglide/messages'), { recursive: true });
        const source = 'export const greeting = () => "Hello";';
        await writeFile(resolve(root, 'src/paraglide/messages/en.js'), source);
        await writeFile(resolve(root, 'src/authored.js'), source);
        for (const [name, value] of [['hello', 'Hello'], ['label_one', 'One'], ['label_two', 'Two']]) {
          await writeFile(resolve(root, 'src/paraglide/messages', name + '.js'),
            'export const ' + name + ' = (inputs = {}, options = {}) => ' + JSON.stringify(value) + ' + (options.locale || "en");');
        }
        await writeFile(resolve(root, 'src/paraglide/messages/unused.js'), 'throw new Error("unvisited message loaded");');
        await writeFile(resolve(root, 'src/paraglide/messages.js'), 'throw new Error("full catalogue loaded");');
        await writeFile(resolve(root, 'src/visit.js'),
          'import { m } from "./paraglide/messages.js"; export const hello = () => m.hello({}, {locale: "de"});' +
          'const density = { s: "small", m: "medium" }; export const medium = density.m;' +
          'export const label = (value) => m[\`label_\${value}\`]();');
        await writeFile(resolve(root, 'src/namespace.js'),
          'import { m } from "./paraglide/messages.js"; export const messages = { m };');
        const server = await createServer({
          configFile: false, root, plugins: [messageImports(root), generatedMessageSourceMaps(root)],
          server: { middlewareMode: true, watch: null, hmr: false },
          optimizeDeps: { noDiscovery: true, include: [] },
        });
        try {
          const generated = await server.environments.ssr.transformRequest('/src/paraglide/messages/en.js');
          assert.equal(generated.map.mappings, '', 'SSR must not recreate generated catalogue maps');
          assert.ok(generated.code.includes('__vite_ssr_exportName__'), 'real SSR transform still runs');
          const visit = await server.ssrLoadModule('/src/visit.js');
          assert.equal(visit.hello(), 'Hellode', 'explicit locale and inputs survive direct imports');
          assert.equal(visit.medium, 'medium', 'unrelated property names do not load the full catalogue');
          assert.equal(visit.label('one'), 'Oneen');
          assert.equal(visit.label('two'), 'Twoen', 'computed template retains all matching messages');
          const namespace = await server.environments.ssr.transformRequest('/src/namespace.js');
          assert.ok(namespace.code.includes('paraglide/messages.js'), 'unrestricted namespace stays intact');
          const authored = await server.environments.ssr.transformRequest('/src/authored.js');
          assert.ok(authored.map.mappings.length > 0, 'authored source keeps its debugging map');
        } finally {
          await server.close();
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
