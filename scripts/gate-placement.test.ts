import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gatePlacement } from './gate.ts';

const repository = resolve(import.meta.dir, '..');
const validHosts = {
  hosts: [
    {
      name: 'a',
      address: 'ops@a.test',
      identity: '/keys/a',
      memoryMaxGiB: 28,
      cpuQuotaPercent: 1100,
      slots: 11,
    },
    {
      name: 'b',
      address: 'ops@b.test',
      identity: '/keys/b',
      memoryMaxGiB: 58,
      cpuQuotaPercent: 1500,
      slots: 15,
    },
  ],
};

let temporaryRoot: string;

beforeAll(() => {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  temporaryRoot = mkdtempSync(join(repository, '.temp/gate-placement-'));
});

afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function checkout(name: string): string {
  const path = join(temporaryRoot, name);
  mkdirSync(path, { recursive: true });
  const initialized = Bun.spawnSync(['git', 'init', '-q'], { cwd: path });
  expect(initialized.exitCode).toBe(0);
  return path;
}

function writeSharedHosts(root: string, hosts: unknown = validHosts): string {
  const file = join(root, '.temp/goal/remote-check-hosts.json');
  mkdirSync(join(root, '.temp/goal'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(hosts)}\n`);
  return file;
}

test('uses the shared main-checkout hosts file and refuses an invalid explicit override', () => {
  const root = checkout('shared-hosts');
  const shared = writeSharedHosts(root);

  expect(gatePlacement(root, {})).toEqual({ kind: 'remote', hostsFile: shared });

  const missing = join(root, '.temp/goal/missing-hosts.json');
  expect(gatePlacement(root, { KERNEL_CHECK_REMOTE: missing })).toEqual({
    kind: 'unavailable',
    reason: `the hosts file ${missing} is not readable`,
  });
});

test('missing and empty host pools fail closed even with caller placement markers', () => {
  const noConfig = join(temporaryRoot, 'no-config');
  mkdirSync(noConfig);
  const forgedMarkers = {
    KERNEL_CHECK_ON_REMOTE: '1',
    REZICS_STACK_REMOTE: 'off',
    REZICS_CHECK_LOCAL_ONLY: '1',
    REZICS_CHECK_MEMORY_LEASE: 'already-held',
    REZICS_STACK_SLOT: 'already-held',
  };

  expect(gatePlacement(noConfig, forgedMarkers)).toEqual({
    kind: 'unavailable',
    reason: 'no check host is configured',
  });

  const emptyRoot = checkout('empty-hosts');
  const emptyFile = writeSharedHosts(emptyRoot, { hosts: [] });
  expect(gatePlacement(emptyRoot, {})).toEqual({
    kind: 'unavailable',
    reason: `${emptyFile} lists no hosts`,
  });
});

test('forged local or remote markers do not change off-host placement', () => {
  const root = checkout('markers');
  const shared = writeSharedHosts(root);
  const env = {
    KERNEL_CHECK_REMOTE: shared,
    KERNEL_CHECK_ON_REMOTE: '1',
    REZICS_STACK_REMOTE: 'off',
    REZICS_CHECK_LOCAL_ONLY: '1',
    REZICS_CHECK_MEMORY_LEASE: 'already-held',
    REZICS_STACK_SLOT: 'already-held',
  };

  expect(gatePlacement(root, env)).toEqual({ kind: 'remote', hostsFile: shared });

  const pathWithRemoteWords = join(repository, '.temp/srv/rezics-check/runs/fake');
  expect(gatePlacement(pathWithRemoteWords, { KERNEL_CHECK_ON_REMOTE: '1' })).toEqual({
    kind: 'unavailable',
    reason: 'no check host is configured',
  });
  expect(gatePlacement('/srv/rezics-check/runs/physical-run', {})).toEqual({
    kind: 'local',
    reason: 'already on a check host',
  });
});
