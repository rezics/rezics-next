import { expect, test } from 'bun:test';
import {
  privateNetworkCommand,
  sharedViteChildEnvironment,
  webTestPrivateNetworkEnvName,
} from '../scripts/with-dev-server.ts';
import { readExampleWorkerVars } from '../scripts/dev-vars.ts';

test('the shared Vite child fills example Worker bindings without replacing a caller value', () => {
  const example = readExampleWorkerVars();
  expect(example.WEBSITE_CLIENT_KEY).toContain('"kty":"EC"');
  const filled = sharedViteChildEnvironment({ PATH: '/bin' });
  expect(filled.WEBSITE_CLIENT_KEY).toBe(example.WEBSITE_CLIENT_KEY);
  expect(filled.CLOUDFLARE_VITE_FORCE_LOCAL).toBe('true');
  expect(filled.CLOUDFLARE_CF_FETCH_ENABLED).toBe('false');
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
  expect(caller.CLOUDFLARE_CF_FETCH_ENABLED).toBe('false');
});

test('private-network wrapping keeps the original command after the namespace setup', () => {
  expect(privateNetworkCommand(['bun', 'test', 'tests/search.test.ts'])).toEqual([
    'unshare',
    '--user',
    '--map-root-user',
    '--net',
    'sh',
    '-c',
    'ip link set lo up && exec "$@"',
    'sh',
    'bun',
    'test',
    'tests/search.test.ts',
  ]);
  expect(webTestPrivateNetworkEnvName).toBe('WEB_TEST_PRIVATE_NETWORK');
});
