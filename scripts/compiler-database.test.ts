import { expect, test } from 'bun:test';
import { compilerDatabaseListenUrl, dockerNetworkArgs, sharesIsolatedStackNetwork } from './compiler-database.ts';

test('isolated stack attachment uses container identity, never a Linux ns path as a network name', () => {
  expect(dockerNetworkArgs({})).toEqual([]);
  expect(dockerNetworkArgs({ REZICS_ISOLATED_STACK_CONTAINER: 'pause-stack-1' })).toEqual([
    '--network',
    'container:pause-stack-1',
  ]);
  expect(sharesIsolatedStackNetwork(['--network', 'container:pause-stack-1'])).toBe(true);
  expect(dockerNetworkArgs({ REZICS_DOCKER_NETWORK: 'rezics-check' })).toEqual(['--network', 'rezics-check']);
  expect(sharesIsolatedStackNetwork(['--network', 'rezics-check'])).toBe(false);
  expect(compilerDatabaseListenUrl('5432')).toBe('postgres://rezics:rezics@127.0.0.1:5432/rezics?sslmode=disable');
  expect(() => dockerNetworkArgs({ REZICS_DOCKER_NETWORK: 'ns:/proc/1/ns/net' })).toThrow(
    'Docker treats ns:/proc/... as a network name',
  );
  expect(() => dockerNetworkArgs({ REZICS_ISOLATED_STACK_CONTAINER: 'ns:/proc/1/ns/net' })).toThrow(
    'Docker treats ns:/proc/... as a network name',
  );
});
