import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapContainers, staleContainers } from './containers.ts';

function dockerSandbox() {
  const directory = mkdtempSync(join(tmpdir(), 'containers-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  return {
    directory,
    bin,
    close() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const emptyDb = { query: () => ({ all: () => [] }) } as unknown as Database;

test('only old containers not protected by keep prefixes or running task names are stale', () => {
  const hour = 3_600_000,
    now = 100 * hour;
  const rows = [
    { id: 'old', name: 'focused_yalow', createdMs: now - 7 * hour },
    { id: 'young', name: 'nice_greider', createdMs: now - hour },
    { id: 'kept', name: 'rezics-dev-fuseki-1', createdMs: now - 200 * hour },
    { id: 'owned', name: 'rezics-kernel-schema-a61d3d3d', createdMs: now - 9 * hour },
  ];
  expect(staleContainers(rows, { maxAgeHours: 4, keep: ['rezics-dev-'] }, ['a61d3d3d-0000'], now)).toEqual(['old']);
  expect(staleContainers(rows, { maxAgeHours: -1, keep: [] }, [], now)).toEqual([]);
});

test.serial('invalid policy is rejected before Docker inventory is read', () => {
  const box = dockerSandbox();
  const state = join(box.directory, 'state');
  const calls = join(box.directory, 'calls');
  mkdirSync(state);
  executable(join(box.bin, 'docker'), `#!/bin/sh\nprintf called >> '${calls}'\n`);
  try {
    for (const policy of ['{"maxAgeHours":-1}', '{"maxAgeHours":1e999}', '{"keep":"rezics-"}', '{"keep":["",7]}']) {
      writeFileSync(join(state, 'containers.json'), policy);
      expect(reapContainers(emptyDb, state)).toBe(0);
    }
    expect(existsSync(calls)).toBe(false);
  } finally {
    box.close();
  }
});

test.serial('reaping keeps protected containers and counts only removals Docker confirms', () => {
  const box = dockerSandbox();
  const state = join(box.directory, 'state');
  const trace = join(box.directory, 'trace');
  const previousTrace = process.env.CONTAINER_TRACE;
  const previousOutput = process.env.CONTAINER_RM_OUTPUT;
  mkdirSync(state);
  writeFileSync(join(state, 'containers.json'), '{"maxAgeHours":4,"keep":["rezics-dev-"]}');
  executable(
    join(box.bin, 'docker'),
    `#!/bin/sh\ncase "$1" in\n  ps) printf 'old-id\\tfocused_yalow\\t2026-11-02 00:00:00 +0800 CST\\n'; printf 'young-id\\tnice_greider\\t2026-11-03 11:00:00 +0800 CST\\n'; printf 'kept-id\\trezics-dev-fuseki-1\\t2026-11-02 00:00:00 +0800 CST\\n'; printf 'owned-id\\trezics-kernel-schema-a61d3d3d\\t2026-11-02 00:00:00 +0800 CST\\n' ;;\n  rm) printf '%s\\n' "$*" >> "$CONTAINER_TRACE"; if [ -n "$CONTAINER_RM_OUTPUT" ]; then printf '%s\\n' "$CONTAINER_RM_OUTPUT"; fi; exit 1 ;;\nesac\n`,
  );
  process.env.CONTAINER_TRACE = trace;
  try {
    const now = Date.parse('2026-11-03T12:00:00+08:00');
    const db = { query: () => ({ all: () => [{ task_id: 'a61d3d3d-0000' }] }) } as unknown as Database;
    process.env.CONTAINER_RM_OUTPUT = 'focused_yalow';
    expect(reapContainers(db, state, now)).toBe(1);
    process.env.CONTAINER_RM_OUTPUT = '';
    expect(reapContainers(db, state, now)).toBe(0);
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(['rm -f -v old-id', 'rm -f -v old-id']);
  } finally {
    if (previousTrace === undefined) delete process.env.CONTAINER_TRACE;
    else process.env.CONTAINER_TRACE = previousTrace;
    if (previousOutput === undefined) delete process.env.CONTAINER_RM_OUTPUT;
    else process.env.CONTAINER_RM_OUTPUT = previousOutput;
    box.close();
  }
});

test.serial(
  'a Docker removal that hangs is terminated within the operation bound',
  () => {
    const box = dockerSandbox();
    const state = join(box.directory, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'containers.json'), '{"maxAgeHours":4}');
    executable(
      join(box.bin, 'docker'),
      `#!/bin/sh\ncase "$1" in\n  ps) printf 'old-id\\tfocused_yalow\\t2026-11-02 00:00:00 +0800 CST\\n' ;;\n  rm) exec sleep 60 ;;\nesac\n`,
    );
    try {
      const started = Date.now();
      expect(reapContainers(emptyDb, state, Date.parse('2026-11-03T12:00:00+08:00'))).toBe(0);
      expect(Date.now() - started).toBeLessThan(25_000);
    } finally {
      box.close();
    }
  },
  25_000,
);
