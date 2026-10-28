import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { workerEnvironment } from './launch.ts';
import { settle } from './settle.ts';
import { harness } from './test-support.ts';
import { removeAttemptContainers } from './worker-containers.ts';

const root = resolve(import.meta.dir, '../../..');
const wrapper = join(root, 'scripts/check-host/docker');
// The worker docker wrapper is dev tooling; on main (where the control plane runs) it arrives with promotion.
const hasWrapper = existsSync(wrapper);

function sandbox(): { directory: string; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'worker-containers-'));
  return { directory, close: () => rmSync(directory, { recursive: true, force: true }) };
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

test.serial.skipIf(!hasWrapper)(
  "a worker's environment uses the worktree wrapper, which forwards all container starts with slice and attempt labels",
  () => {
    const box = sandbox();
    try {
      const worktree = join(box.directory, 'worktree');
      const wrapperDirectory = join(worktree, 'scripts/check-host');
      const realDocker = join(box.directory, 'bin/docker');
      const records = join(box.directory, 'docker-args');
      mkdirSync(wrapperDirectory, { recursive: true });
      mkdirSync(dirname(realDocker), { recursive: true });
      copyFileSync(wrapper, join(wrapperDirectory, 'docker'));
      chmodSync(join(wrapperDirectory, 'docker'), 0o755);
      executable(realDocker, `#!/bin/sh\nprintf '<%s>' "$@" >> "$DOCKER_ARGS"\nprintf '\\n' >> "$DOCKER_ARGS"\n`);
      const env = workerEnvironment(
        { cli: 'codex', configDirectory: '/config' } as never,
        { GOAL_TASK_ID: 'task-7', GOAL_ATTEMPT: '3' },
        { PATH: `${dirname(realDocker)}:/bin:/usr/bin`, DOCKER_ARGS: records },
        worktree,
      );
      expect(env.PATH?.split(':')[0]).toBe(wrapperDirectory);
      expect(env.PATH?.split(':')).toContain(dirname(realDocker));
      const starts = [
        ['run', '--rm', 'image'],
        ['create', 'image'],
        ['container', 'run', '--rm', 'image'],
        ['container', 'create', 'image'],
      ];
      for (const args of starts) {
        const result = spawnSync('docker', args, { cwd: worktree, env, encoding: 'utf8' });
        expect(result.status).toBe(0);
      }
      const rows = readFileSync(records, 'utf8').trim().split('\n');
      expect(rows).toHaveLength(4);
      for (const [index, args] of starts.entries()) {
        const forwarded = rows[index]!;
        expect(forwarded.startsWith(`<${args[0]}>`)).toBe(true);
        expect(forwarded).toContain('<--cgroup-parent=rezics-check.slice>');
        expect(forwarded).toContain('<--label><rezics.worker.attempt=task-7/3>');
        expect(forwarded).toContain(`<${args.at(-1)}>`);
      }
    } finally {
      box.close();
    }
  },
);

test.serial('attempt cleanup lists by the exact attempt label and removes only returned containers', () => {
  const box = sandbox();
  const previousPath = process.env.PATH;
  const previousRmLog = process.env.WORKER_CONTAINER_RM_LOG;
  const previousTrace = process.env.WORKER_CONTAINER_TRACE;
  try {
    const bin = join(box.directory, 'bin');
    const docker = join(bin, 'docker');
    const rmLog = join(box.directory, 'removed');
    mkdirSync(bin);
    executable(
      docker,
      `#!/bin/sh\ncase "$1" in\n  ps) printf '%s\\n' "$*" >> "$WORKER_CONTAINER_TRACE"; printf 'owned-a\\nowned-b\\n' ;;\n  rm) printf '%s\\n' "$*" >> "$WORKER_CONTAINER_RM_LOG" ;;\n  *) exit 2 ;;\nesac\n`,
    );
    process.env.PATH = bin;
    process.env.WORKER_CONTAINER_RM_LOG = rmLog;
    process.env.WORKER_CONTAINER_TRACE = join(box.directory, 'trace');
    removeAttemptContainers('task-7', 3);
    expect(readFileSync(rmLog, 'utf8').trim()).toBe('rm -f owned-a owned-b');
    expect(readFileSync(process.env.WORKER_CONTAINER_TRACE, 'utf8').trim()).toBe(
      'ps -aq --filter label=rezics.worker.attempt=task-7/3',
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousRmLog === undefined) delete process.env.WORKER_CONTAINER_RM_LOG;
    else process.env.WORKER_CONTAINER_RM_LOG = previousRmLog;
    if (previousTrace === undefined) delete process.env.WORKER_CONTAINER_TRACE;
    else process.env.WORKER_CONTAINER_TRACE = previousTrace;
    box.close();
  }
});

test.serial(
  'success, failure, stop and cancel exits all clean their attempt containers during settlement',
  async () => {
    const box = sandbox();
    const bin = join(box.directory, 'bin');
    const docker = join(bin, 'docker');
    const rmLog = join(box.directory, 'removed');
    const previousPath = process.env.PATH;
    const harnesses = [
      harness(),
      harness('#!/usr/bin/env bun\nprocess.exit(2);\n'),
      harness('#!/usr/bin/env bun\nsetInterval(() => {}, 1000);\n'),
      harness('#!/usr/bin/env bun\nsetInterval(() => {}, 1000);\n'),
    ];
    try {
      mkdirSync(bin);
      executable(
        docker,
        `#!/bin/sh\ncase "$1" in\n  ps) printf 'owned\\n' ;;\n  rm) printf '%s\\n' "$*" >> '${rmLog}' ;;\n  *) exit 2 ;;\nesac\n`,
      );
      process.env.PATH = `${bin}:${previousPath ?? ''}`;
      for (const [index, h] of harnesses.entries()) {
        const task = h.tasks.dispatch(h.briefFile);
        const running = await h.tasks.retry(task.id);
        if (index < 2) {
          await running.exited;
          await settle(h.tasks, running, { enqueue() {} });
          expect(h.store.attempt(running.attempt).state).toBe('exited');
          expect(Boolean(h.store.attempt(running.attempt).failureKind)).toBe(index === 1);
        } else {
          if (index === 2) await h.tasks.stop(task.id);
          else await h.tasks.cancel(task.id);
          await running.exited;
          await expect(settle(h.tasks, running, { enqueue() {} })).rejects.toThrow();
        }
      }
      expect(readFileSync(rmLog, 'utf8').trim().split('\n')).toEqual([
        'rm -f owned',
        'rm -f owned',
        'rm -f owned',
        'rm -f owned',
      ]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      for (const h of harnesses) h.dispose();
      box.close();
    }
  },
  30_000,
);

test.serial('docker cleanup errors are logged and do not escape attempt settlement', () => {
  const box = sandbox();
  const previousPath = process.env.PATH;
  const errors: string[] = [];
  const originalError = console.error;
  try {
    const bin = join(box.directory, 'bin');
    mkdirSync(bin);
    executable(join(bin, 'docker'), '#!/bin/sh\nexit 1\n');
    process.env.PATH = bin;
    console.error = (message?: unknown) => errors.push(String(message));
    expect(() => removeAttemptContainers('task-7', 3)).not.toThrow();
    expect(errors.join('\n')).toContain('rezics.worker.attempt=task-7/3');
    console.error = () => {
      throw new Error('closed diagnostic stream');
    };
    expect(() => removeAttemptContainers('task-7', 3)).not.toThrow();
  } finally {
    console.error = originalError;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    box.close();
  }
});
