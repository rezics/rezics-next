import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SHARED_KEEP_PREFIXES,
  derivedOwnerGone,
  keepPrefixes,
  nameOwnsTask,
  parseContainerList,
  parseDockerSize,
  reapAttemptResources,
  reapedCountsLastHour,
  selectOwnedContainers,
  selectOwnedVolumes,
  sweepAbandonedResources,
  type DockerInvoke,
  type InventoryContainer,
} from './attempt-resources.ts';
import { defaultPolicy } from './policy.ts';

const taskId = 'd79b5cfd-2a63-4542-83ee-2e08ceb9c0bf';
const now = Date.parse('2026-11-06T12:00:00+08:00');

function stateDir(): { directory: string; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'attempt-resources-'));
  mkdirSync(directory, { recursive: true });
  return { directory, close: () => rmSync(directory, { recursive: true, force: true }) };
}

function container(name: string, extra: Partial<InventoryContainer> = {}): InventoryContainer {
  return {
    id: extra.id ?? name,
    name,
    pidLabel: '',
    startLabel: '',
    bootLabel: '',
    attemptLabel: '',
    sizeBytes: 0,
    ...extra,
  };
}

function dockerScript(script: {
  ps?: string;
  volumes?: string;
  inspect?: string;
  rm?: { ok?: boolean; stdout?: string };
  volumeRm?: { ok?: boolean; stdout?: string };
}): { invoke: DockerInvoke; removed: string[][] } {
  const removed: string[][] = [];
  return {
    removed,
    invoke: async (args) => {
      if (args[0] === 'ps') return { ok: true, stdout: script.ps ?? '' };
      if (args[0] === 'volume' && args[1] === 'ls') return { ok: true, stdout: script.volumes ?? '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { ok: true, stdout: script.inspect ?? '' };
      if (args[0] === 'volume' && args[1] === 'rm') {
        removed.push(args);
        const result = script.volumeRm ?? { ok: true, stdout: args.slice(3).join('\n') };
        return { ok: result.ok ?? true, stdout: result.stdout ?? '' };
      }
      if (args[0] === 'rm') {
        removed.push(args);
        const result = script.rm ?? { ok: true, stdout: args.slice(3).join('\n') };
        return { ok: result.ok ?? true, stdout: result.stdout ?? '' };
      }
      return { ok: false, stdout: '' };
    },
  };
}

test('walk, task-named and labelled resources are owned; shared keep prefixes are not', () => {
  const keep = keepPrefixes();
  expect(keep).toEqual([...SHARED_KEEP_PREFIXES]);
  expect(nameOwnsTask(`rezics-walk-${taskId}-database`, taskId)).toBe(true);
  expect(nameOwnsTask(`rezics-${taskId}-cache`, taskId)).toBe(true);
  expect(nameOwnsTask('rezics-dev-fuseki-1', taskId)).toBe(false);
  const live = new Map<string, { start: string; boot: string }>([['4242', { start: '100', boot: 'boot' }]]);
  const ownerLive = (pid: string) => live.get(pid) ?? null;
  const rows = [
    container(`rezics-walk-${taskId}-database`, { id: 'walk', sizeBytes: 10 }),
    container(`rezics-${taskId}-tmp`, { id: 'task', sizeBytes: 2 }),
    container('busybox', { id: 'labelled', attemptLabel: `${taskId}/3`, sizeBytes: 3 }),
    container('focused_yalow', { id: 'dead', pidLabel: '99', startLabel: '1', bootLabel: 'boot', sizeBytes: 14 }),
    container('alive-db', { id: 'alive', pidLabel: '4242', startLabel: '100', bootLabel: 'boot', sizeBytes: 8 }),
    container('reused-db', { id: 'reused', pidLabel: '4242', startLabel: '9', bootLabel: 'boot', sizeBytes: 8 }),
    container('rezics-dev-fuseki-1', { id: 'dev', sizeBytes: 99 }),
    container('rezics-doctor-pg', { id: 'doctor', sizeBytes: 99 }),
    container('rezics-kernel-dev', { id: 'kernel', sizeBytes: 99 }),
    container('rezics-pagecheck-web', { id: 'page', sizeBytes: 99 }),
  ];
  expect(selectOwnedContainers(rows, [taskId], keep, ownerLive).map((row) => row.id)).toEqual([
    'walk',
    'task',
    'labelled',
    'dead',
    'reused',
  ]);
  expect(
    selectOwnedVolumes(
      [
        { name: `rezics-walk-${taskId}-database`, pidLabel: '', startLabel: '', bootLabel: '', sizeBytes: 10 },
        { name: 'rezics-dev-data', pidLabel: '', startLabel: '', bootLabel: '', sizeBytes: 99 },
        { name: 'orphan-db', pidLabel: '99', startLabel: '1', bootLabel: 'boot', sizeBytes: 4 },
        { name: 'reused-vol', pidLabel: '4242', startLabel: '9', bootLabel: 'boot', sizeBytes: 4 },
        { name: 'live-vol', pidLabel: '4242', startLabel: '100', bootLabel: 'boot', sizeBytes: 4 },
      ],
      [taskId],
      keep,
      ownerLive,
    ).map((row) => row.name),
  ).toEqual([`rezics-walk-${taskId}-database`, 'orphan-db', 'reused-vol']);
  expect(derivedOwnerGone({ pidLabel: '4242', startLabel: '9', bootLabel: 'boot' }, live.get('4242')!)).toBe(true);
  expect(derivedOwnerGone({ pidLabel: '4242', startLabel: '100', bootLabel: 'boot' }, live.get('4242')!)).toBe(false);
  expect(derivedOwnerGone({ pidLabel: '99', startLabel: '1', bootLabel: 'boot' }, null)).toBe(true);
});

test('an ended attempt reaps its worktree processes and owned containers and volumes, and keeps shared stacks', async () => {
  const box = stateDir();
  const logs: string[] = [];
  const stopped: string[] = [];
  const listed = parseContainerList(
    [
      `walk\trezics-walk-${taskId}-database\t\t\t\t\t12MB`,
      `task\trezics-${taskId}-scratch\t\t\t\t\t2MiB`,
      `keep\trezics-dev-fuseki-1\t\t\t\t\t1GB`,
      `dead\tfocused_yalow\t88\t1\tboot\t\t14GB`,
    ].join('\n'),
  );
  const docker = dockerScript({
    ps: [
      `walk\trezics-walk-${taskId}-database\t\t\t\t\t12MB`,
      `task\trezics-${taskId}-scratch\t\t\t\t\t2MiB`,
      `keep\trezics-dev-fuseki-1\t\t\t\t\t1GB`,
      `dead\tfocused_yalow\t88\t1\tboot\t\t14GB`,
    ].join('\n'),
    volumes: `rezics-walk-${taskId}-database\nrezics-dev-data\norphan`,
    inspect: [
      `rezics-walk-${taskId}-database\t\t\t\t/var/lib/docker/volumes/walk\t4MB`,
      `rezics-dev-data\t\t\t\t/var/lib/docker/volumes/dev\t9GB`,
      `orphan\t88\t1\tboot\t/var/lib/docker/volumes/orphan\t5MB`,
    ].join('\n'),
  });
  try {
    expect(parseDockerSize('12MB (virtual 1GB)')).toBe(12_000_000);
    expect(listed.map((row) => row.id)).toEqual(['walk', 'task', 'keep', 'dead']);
    const counts = await reapAttemptResources({
      taskId,
      stateDirectory: box.directory,
      worktree: join(box.directory, 'worktree'),
      now,
      docker: docker.invoke,
      ownerLive: () => null,
      processes: {
        list: () => [{ pid: 501, sizeBytes: 4096 }],
        stop: async (directory) => {
          stopped.push(directory);
          return 1;
        },
      },
      log: (line) => logs.push(line),
    });
    expect(docker.removed[0]).toEqual(['rm', '-f', '-v', 'walk', 'task', 'dead']);
    expect(docker.removed.some((args) => args[0] === 'volume' && args.includes('orphan'))).toBe(true);
    expect(docker.removed.some((args) => args.includes('rezics-dev-fuseki-1') || args.includes('keep'))).toBe(false);
    expect(stopped).toEqual([join(box.directory, 'worktree')]);
    expect(counts).toEqual({
      processes: 1,
      containers: 3,
      volumes: 2,
      bytes: 12_000_000 + 2 * 1024 * 1024 + 14_000_000_000 + 4_000_000 + 5_000_000 + 4096,
    });
    expect(logs).toEqual([
      `reap container rezics-walk-${taskId}-database owner=${taskId} size=12000000`,
      `reap container rezics-${taskId}-scratch owner=${taskId} size=${2 * 1024 * 1024}`,
      'reap container focused_yalow owner=derived:88 size=14000000000',
      `reap volume rezics-walk-${taskId}-database owner=${taskId} size=4000000`,
      'reap volume orphan owner=derived:88 size=5000000',
      'reap process 501 owner=d79b5cfd-2a63-4542-83ee-2e08ceb9c0bf size=4096',
    ]);
    expect(reapedCountsLastHour(box.directory, now)).toEqual(counts);
    expect(reapedCountsLastHour(box.directory, now + 3_600_001)).toEqual({
      processes: 0,
      containers: 0,
      volumes: 0,
      bytes: 0,
    });
    expect(readFileSync(join(box.directory, 'reaped-resources.jsonl'), 'utf8')).toContain(`"owner":"${taskId}"`);
  } finally {
    box.close();
  }
});

test('a five-minute sweep reaps cancelled, stopped, integrated and merged tasks and dead throwaway databases, not a live owner or a running task', async () => {
  const box = stateDir();
  const running = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const cancelled = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const stopped = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const integrated = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const merged = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const docker = dockerScript({
    ps: [
      `run\trezics-walk-${running}-database\t\t\t\t\t1MB`,
      `can\trezics-walk-${cancelled}-database\t\t\t\t\t2MB`,
      `stop\trezics-walk-${stopped}-database\t\t\t\t\t3MB`,
      `int\trezics-walk-${integrated}-database\t\t\t\t\t4MB`,
      `mer\trezics-walk-${merged}-database\t\t\t\t\t5MB`,
      `dead\tleaky-pg\t77\t1\tboot\t\t6MB`,
      `live\twarm-pg\t4242\t100\tboot\t\t7MB`,
      `keep\trezics-kernel-dev\t\t\t\t\t8MB`,
    ].join('\n'),
  });
  const stoppedTrees: string[] = [];
  try {
    const counts = await sweepAbandonedResources({
      tasks: [
        { id: running, state: 'running', worktree: '/tmp/running' },
        { id: cancelled, state: 'cancelled', worktree: '/tmp/cancelled' },
        { id: stopped, state: 'stopped', worktree: '/tmp/stopped' },
        { id: integrated, state: 'integrated', worktree: '/tmp/integrated' },
        { id: merged, state: 'merged', worktree: '/tmp/merged' },
      ],
      stateDirectory: box.directory,
      now,
      docker: docker.invoke,
      ownerLive: (pid) => (pid === '4242' ? { start: '100', boot: 'boot' } : null),
      processes: {
        list: (directory) => (directory === '/tmp/cancelled' ? [{ pid: 9, sizeBytes: 2048 }] : []),
        stop: async (directory) => {
          stoppedTrees.push(directory);
          return 1;
        },
      },
      log: () => {},
    });
    expect(docker.removed[0]?.slice(3)).toEqual(['can', 'stop', 'int', 'mer', 'dead']);
    expect(stoppedTrees).toEqual(['/tmp/cancelled', '/tmp/stopped', '/tmp/integrated', '/tmp/merged']);
    expect(counts.containers).toBe(5);
    expect(counts.processes).toBe(1);
    expect(defaultPolicy.containers.cleanupIntervalMs).toBe(300_000);
    expect(defaultPolicy.containers.keep).toEqual([...SHARED_KEEP_PREFIXES]);
  } finally {
    box.close();
  }
});

test('throwaway Kernel databases start with --rm and owner identity labels so a reused pid cannot keep them', () => {
  const source = readFileSync(resolve(import.meta.dir, '../../../services/kernel/scripts/derived.ts'), 'utf8');
  const fn = source.slice(
    source.indexOf('export function throwawayDatabaseRunArgs'),
    source.indexOf('function reusableDatabaseUrl'),
  );
  expect(fn).toContain("'--rm'");
  expect(fn).toContain('rezics.kernel.derived.pid=');
  expect(fn).toContain('rezics.kernel.derived.start=');
  expect(fn).toContain('rezics.kernel.derived.boot=');
  expect(fn).toContain('volume-label=${label}');
});
