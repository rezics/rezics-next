import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('installed serve composition bounds client dependency optimization without crawling the server entry', () => {
  // Resolve under Node, like the installed Vite CLI. The unmerged app configuration cannot reveal entries added
  // by TanStack and Cloudflare's environment hooks. No network listener or native service is started here.
  const result = Bun.spawnSync({
    cmd: [
      'node',
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
        import { createRequire } from 'node:module';
        import { resolve } from 'node:path';
        import { createServer, resolveConfig } from 'vite';
        import { tanStackRouterCodeSplitter, tanstackRouterGenerator } from '@tanstack/router-plugin/vite';
        import { messageImports } from './scripts/message-imports.ts';
        import { generatedMessageSourceMaps } from './scripts/generated-message-source-maps.ts';
        delete process.env.REZICS_TEST_RUNTIME;
        delete process.env.REZICS_WALK_STACK_SLOT;
        const config = await resolveConfig({ logLevel: 'silent' }, 'serve', 'development');
        assert.ok(
          config.plugins.some((plugin) => plugin.name === 'tanstack-router:code-splitter:compile-reference-file'),
          'the installed Web Start serve config enables route code splitting',
        );
        for (const [name, options] of [
          ['root', config.optimizeDeps],
          ['client', config.environments.client.optimizeDeps],
        ]) {
          assert.deepEqual(options.entries, [], name + ': no startup source crawl');
          assert.equal(options.holdUntilCrawlEnd, false, name + ': on-demand discovery');
          assert.equal(options.noDiscovery, true, name + ': dependency discovery stays bounded');
          assert.ok(options.include.includes('@base-ui/react/*'), name + ': shell primitives are prebundled');
          assert.ok(options.include.includes('lucide-react'), name + ': navigation icons are prebundled');
        }
        for (const dependency of ['@puckeditor/core > flat', '@puckeditor/core > object-hash']) {
          assert.ok(config.environments.client.optimizeDeps.include.includes(dependency), 'client prebundles ' + dependency);
        }
        const clientShim = config.environments.client.resolve.alias.find(
          (alias) => alias.find instanceof RegExp && alias.find.test('use-sync-external-store/shim'),
        );
        assert.equal(clientShim?.replacement, 'react', 'Base UI shim resolves through React’s hook export');
        assert.equal(
          clientShim?.find instanceof RegExp && clientShim.find.test('use-sync-external-store/shim/index.js'),
          true,
          'the explicit package file path is covered by the same alias',
        );
        const worker = config.environments.ssr.optimizeDeps;
        assert.deepEqual(worker.entries, []);
        assert.equal(worker.noDiscovery, true);
        assert.ok(worker.include.includes('react-dom/server.edge'));
        assert.ok(worker.include.includes('typebox/type'));
        assert.ok(worker.include.includes('lucide-react'));
        assert.ok(worker.include.includes('@base-ui/react/*'));
        assert.ok(worker.include.includes('@puckeditor/core > flat'));
        assert.ok(worker.include.includes('@puckeditor/core > object-hash'));

        const tempRoot = resolve('../../.temp');
        await mkdir(tempRoot, { recursive: true });
        const cacheRoot = await mkdtemp(resolve(tempRoot, 'client-module-boundary-'));
        const selectorPlugin = config.plugins.find((plugin) => plugin.name === 'web-selector-esm');
        assert.ok(selectorPlugin, 'the installed config includes its shared selector adapter');
        let clientServer;
        try {
          const clientIncludes = ['@puckeditor/core > flat', '@puckeditor/core > object-hash', 'react'];
          clientServer = await createServer({
            configFile: false,
            root: process.cwd(),
            cacheDir: resolve(cacheRoot, 'vite'),
            plugins: [selectorPlugin],
            resolve: config.environments.client.resolve,
            optimizeDeps: {
              ...config.environments.client.optimizeDeps,
              entries: [],
              include: clientIncludes,
              force: true,
            },
            server: { ...config.server, middlewareMode: true, watch: null, hmr: false },
            appType: 'custom',
            logLevel: 'silent',
          });
          const clientEnvironment = clientServer.environments.client;
          const optimizer = clientEnvironment.depsOptimizer;
          assert.ok(optimizer, 'the installed client environment owns a dependency optimizer');
          await optimizer.init();
          assert.deepEqual(optimizer.options.entries, [], 'the installed optimizer keeps startup entries empty');
          assert.equal(optimizer.options.noDiscovery, true, 'the installed optimizer keeps discovery bounded');
          const pending = Object.values(optimizer.metadata.discovered).flatMap((dependency) =>
            dependency.processing ? [dependency.processing] : [],
          );
          await Promise.all(pending);
          const flat = optimizer.metadata.optimized['@puckeditor/core > flat'];
          const objectHash = optimizer.metadata.optimized['@puckeditor/core > object-hash'];
          assert.ok(flat, 'installed Puck flat dependency is optimized in the client environment');
          assert.ok(objectHash, 'installed Puck object-hash dependency is optimized in the client environment');
          const flatCode = await readFile(flat.file, 'utf8');
          const objectHashCode = await readFile(objectHash.file, 'utf8');
          assert.match(flatCode, /export\\s*\\{[^}]*\\bas\\s+default\\b/s, 'optimized flat supplies a default export');
          assert.match(flatCode, /\\bflatten\\b/);
          assert.match(flatCode, /\\bunflatten\\b/);
          assert.match(objectHashCode, /\\bexport\\b/, 'optimized object-hash supplies ESM exports');

          const baseUi = createRequire(resolve('package.json')).resolve('@base-ui/react');
          const baseUiRequire = createRequire(baseUi);
          for (const shim of ['index.js', 'with-selector.js']) {
            const shimPath = baseUiRequire.resolve('use-sync-external-store/shim/' + shim);
            const transformed = await clientEnvironment.transformRequest('/@fs' + shimPath.replace(/\\\\/g, '/'));
            assert.ok(transformed, 'installed client transforms the selector shim ' + shim);
            const expectedExport = shim === 'index.js' ? 'useSyncExternalStore' : 'useSyncExternalStoreWithSelector';
            assert.ok(transformed.code.includes(expectedExport), shim + ': ESM selector export reaches React');
            assert.ok(!transformed.code.includes('module.exports'), shim + ': raw CommonJS is replaced');
          }
          const composition = await clientEnvironment.transformRequest('/src/features/zones/editor/composition.tsx');
          assert.ok(composition?.code.includes('Puck'), 'the installed Puck client entry transforms');
        } finally {
          await clientServer?.close();
          await rm(cacheRoot, { recursive: true, force: true });
        }
        const routeSplitOptions = {
          routesDirectory: 'src/routes',
          generatedRouteTree: 'src/routeTree.gen.ts',
          target: 'react',
          codeSplittingOptions: {
            defaultBehavior: [
              ['loader'],
              ['component'],
              ['pendingComponent'],
              ['errorComponent'],
              ['notFoundComponent'],
            ],
          },
        };
        const routes = await createServer({
          configFile: false, logLevel: 'silent',
          plugins: [
            messageImports(process.cwd()),
            tanstackRouterGenerator(routeSplitOptions),
            tanStackRouterCodeSplitter(routeSplitOptions),
          ],
          server: { middlewareMode: true, watch: null, hmr: false },
          optimizeDeps: { noDiscovery: true, include: [] },
        });
        try {
          for (const [file, view] of [
            ['index', '/routes/-home'],
            ['drafts', '/threads/drafts-route'],
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
          const subjectReference = await routes.environments.ssr.transformRequest(
            '/src/routes/subjects/$id_.$slug.tsx',
          );
          assert.ok(subjectReference.code.includes('lazyRouteComponent'), 'Subject view is lazy');
          assert.ok(!subjectReference.code.includes('/features/pages/subject.tsx'), 'Subject view stays out of the route reference');
          assert.ok(
            !subjectReference.code.includes('/features/catalogue/page-render-binding.tsx'),
            'route loaders do not import the Subject React binding',
          );
          const rules = await routes.environments.ssr.transformRequest('/src/community/realm-rules-authoring/panel.tsx');
          assert.ok(rules.code.includes('/paraglide/messages/realm_rules_authoring_open.js'));
          assert.ok(!rules.code.includes('/paraglide/messages.js'), 'rules labels do not load the full catalogue');
          const publicViews = await routes.environments.ssr.transformRequest('/src/settings/public-views.tsx');
          assert.ok(publicViews.code.includes('/paraglide/messages/settings_public_posts.js'));
          assert.ok(!publicViews.code.includes('/paraglide/messages.js'), 'public views do not load the full catalogue');
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
