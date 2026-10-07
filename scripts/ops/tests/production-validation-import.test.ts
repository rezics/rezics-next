import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('site config loaders validate production inputs under Node without Main runtime imports', () => {
  // Run Vite in Node so Bun globals cannot mask nonportable service imports.
  const result = Bun.spawnSync(
    [
      'node',
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import { createServer, isRunnableDevEnvironment } from 'vite';

        const server = await createServer({
          root: process.cwd(),
          configFile: false,
          cacheDir: '.temp/production-validation-vite',
          server: { middlewareMode: true, hmr: false, watch: null },
          appType: 'custom',
          optimizeDeps: { noDiscovery: true },
        });
        try {
          const environment = server.environments.ssr;
          assert.ok(isRunnableDevEnvironment(environment));
          const { checkProductionEnv } = await environment.runner.import('/scripts/ops/production-env.ts');
          const { productionExample } = await environment.runner.import('/scripts/ops/tests/g-722-fixture.ts');
          const env = productionExample();
          for (const role of ['about', 'web', 'accounts', 'main']) {
            assert.doesNotThrow(() => checkProductionEnv(env, [role]));
          }
          assert.throws(() => checkProductionEnv({ ABOUT_SITE_URL: 'http://localhost:4321' }, ['about']), /ABOUT_SITE_URL/);
          assert.throws(() => checkProductionEnv({ ...env, ACCOUNT_TURNSTILE_SITE_KEY: '' }, ['accounts']), /ACCOUNT_TURNSTILE_SITE_KEY/);
          for (const subject of ['TBD', env.SAFETY_BACKUP_ACCOUNT, 'with space', 'a'.repeat(129)]) {
            assert.throws(() => checkProductionEnv({ ...env, SAFETY_PRIMARY_ACCOUNT: subject }, ['main']), /SAFETY_PRIMARY_ACCOUNT/);
          }
          const runtimeModules = [...environment.moduleGraph.idToModuleMap.keys()].filter(id =>
            id.includes('/services/main/src/modules/') &&
            !id.endsWith('/media-screen/required-matcher.ts') &&
            !id.endsWith('/safety-alerts/roster.ts')
          );
          assert.deepEqual(runtimeModules, [], 'production validation must load only pure Main configuration helpers');
        } finally {
          await server.close();
        }
      `,
    ],
    {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    },
  );
  expect(result.exitCode, `${result.stdout.toString()}${result.stderr.toString()}`).toBe(0);
}, 30_000);
