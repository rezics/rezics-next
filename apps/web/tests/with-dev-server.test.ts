import { expect, test } from 'bun:test';
import { sharedViteChildEnvironment } from '../scripts/with-dev-server.ts';
import { readExampleWorkerVars } from '../scripts/dev-vars.ts';

test('the shared Vite child fills example Worker bindings without replacing a caller value', () => {
  const example = readExampleWorkerVars();
  expect(example.WEBSITE_CLIENT_KEY).toContain('"kty":"EC"');
  const filled = sharedViteChildEnvironment({ PATH: '/bin' });
  expect(filled.WEBSITE_CLIENT_KEY).toBe(example.WEBSITE_CLIENT_KEY);
  expect(filled.CLOUDFLARE_VITE_FORCE_LOCAL).toBe('true');
  expect(filled.REZICS_TEST_RUNTIME).toBe('1');
  expect(filled.WEB_VITE_CACHE_DIR).toBeUndefined();

  const caller = sharedViteChildEnvironment(
    { WEBSITE_CLIENT_KEY: 'from-caller', WEB_TEST_STATE_DIR: '/tmp/state' },
    { cacheDirectory: '/tmp/vite-cache' },
  );
  expect(caller.WEBSITE_CLIENT_KEY).toBe('from-caller');
  expect(caller.WEB_TEST_STATE_DIR).toBe('/tmp/state');
  expect(caller.WEB_VITE_CACHE_DIR).toBe('/tmp/vite-cache');
  expect(caller.CLOUDFLARE_VITE_FORCE_LOCAL).toBe('true');
});
