import { afterEach, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  beginDetachedDockerRm,
  COMPILER_NONCE_LABEL,
  COMPILER_PID_LABEL,
  DOCKER_BUILD_TIMEOUT_MS,
  DOCKER_PROBE_TIMEOUT_MS,
  DOCKER_RUN_TIMEOUT_MS,
  cleanupStaleCompilerDatabases,
  compilerDatabaseInspectArgs,
  compilerDatabaseListenUrl,
  compilerDatabaseRemoveArgs,
  compilerDatabaseRunArgs,
  compilerDatabaseVolumeCreateArgs,
  compilerDatabaseVolumeLsArgs,
  compilerDatabaseVolumeRemoveArgs,
  keepCompilerStatusAfterCleanup,
  settleCompilerDatabaseRemoval,
  settleDockerAttempt,
  settleDockerContainerRemoval,
  dockerNetworkArgs,
  dockerProcessText,
  dockerSpawnSyncOptions,
  dockerTimeoutMs,
  isolatedPostgresSocketDir,
  ownerProcessIdentity,
  postgresContainerReadyArgs,
  postgresPublishArgs,
  postgresReadyProbe,
  reapCompilerNonce,
  reapLabeledContainers,
  retainOriginalAndCleanupFailure,
  sharesIsolatedStackNetwork,
  startCompilerContainer,
  startPostgresForwarder,
  waitForPostgresContainer,
  waitForPostgresReady,
} from './compiler-database.ts';

const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('docker run, create and forced rm use Auth run timeout; probes stay short', () => {
  expect(DOCKER_RUN_TIMEOUT_MS).toBe(120_000);
  expect(DOCKER_PROBE_TIMEOUT_MS).toBe(5_000);
  expect(dockerTimeoutMs(['run', '-d', '--rm', 'postgres'])).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(dockerTimeoutMs(['create', '--name', 'x', 'postgres'])).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(dockerTimeoutMs(['rm', '-f', '-v', 'x'])).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(dockerTimeoutMs(['rm', '-f', 'x'])).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(dockerTimeoutMs(['volume', 'create', '--label', 'owner=1', 'data'])).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(dockerTimeoutMs(['volume', 'rm', '-f', 'data'])).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(dockerTimeoutMs(['build', '--tag', 'x', '.'])).toBe(DOCKER_BUILD_TIMEOUT_MS);
  expect(dockerTimeoutMs(['exec', 'x', 'pg_isready'])).toBe(DOCKER_PROBE_TIMEOUT_MS);
  expect(dockerTimeoutMs(['ps', '-aq', '--filter', 'label=rezics.compiler.nonce=x'])).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(dockerTimeoutMs(['ps', '-a'])).toBe(DOCKER_PROBE_TIMEOUT_MS);
  expect(dockerTimeoutMs(['port', 'x', '5432/tcp'])).toBe(DOCKER_PROBE_TIMEOUT_MS);
  const removal = dockerSpawnSyncOptions(['rm', '-f', '-v', 'x']);
  expect(removal.timeout).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(removal.detached).toBeUndefined();
  const reapList = dockerSpawnSyncOptions(['ps', '-aq', '--filter', 'label=rezics.compiler.nonce=x']);
  expect(reapList.timeout).toBe(DOCKER_RUN_TIMEOUT_MS);
  const probe = dockerSpawnSyncOptions(['ps', '-a']);
  expect(probe.timeout).toBe(DOCKER_PROBE_TIMEOUT_MS);
  expect(probe.detached).toBeUndefined();
});

test('the one-run compiler database mounts an exactly labelled volume, not a 1 GiB tmpfs', () => {
  const args = compilerDatabaseRunArgs(9, 'nonce-9', []);
  expect(args[0]).toBe('run');
  expect(args).toContain('--rm');
  expect(args).toContain('--stop-timeout');
  expect(args).toContain(`${COMPILER_PID_LABEL}=9`);
  expect(args).toContain(`${COMPILER_NONCE_LABEL}=nonce-9`);
  expect(args).toContain('--mount');
  expect(args).toContain('type=volume,source=rezics-compiler-pg-9-nonce-9,destination=/var/lib/postgresql');
  expect(args).not.toContain('--tmpfs');
  expect(args).toContain('-p');
  expect(args).toContain('shared_buffers=32MB');
  expect(args).toContain('max_connections=40');
  expect(args).toContain('huge_pages=off');
  expect(compilerDatabaseVolumeCreateArgs(9, 'nonce-9', 'host-run')).toEqual([
    'volume',
    'create',
    '--label',
    `${COMPILER_PID_LABEL}=9`,
    '--label',
    `${COMPILER_NONCE_LABEL}=nonce-9`,
    '--label',
    'rezics.check.run=host-run',
    'rezics-compiler-pg-9-nonce-9',
  ]);
});

test('a failed docker run reaps the nonce before the error escapes', () => {
  const calls: string[][] = [];
  let owned = true;
  const docker = (args: string[]): string => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'create') return args.at(-1)!;
    if (args[0] === 'run') throw new Error('docker run failed with status 125: daemon error');
    if (args[0] === 'ps') return owned ? 'created-unstarted' : '';
    if (args[0] === 'rm') owned = false;
    return '';
  };
  expect(() => startCompilerContainer(9, 'nonce-fail', docker, {})).toThrow(/status 125/);
  expect(calls[0]).toEqual(compilerDatabaseVolumeCreateArgs(9, 'nonce-fail'));
  expect(calls[1]![0]).toBe('run');
  expect(calls[2]).toEqual(['ps', '-aq', '--filter', `label=${COMPILER_NONCE_LABEL}=nonce-fail`]);
  expect(calls[3]).toEqual(compilerDatabaseRemoveArgs('created-unstarted'));
  expect(calls[4]).toEqual(['ps', '-aq', '--filter', `label=${COMPILER_NONCE_LABEL}=nonce-fail`]);
  expect(() =>
    reapCompilerNonce('already-gone', 9, () => {
      throw new Error('daemon timeout');
    }),
  ).toThrow(/unsettled after 3 attempts.*daemon timeout/);
});

test('a docker run spawn timeout reaps the nonce, retries once, then keeps the second failure', () => {
  const calls: string[][] = [];
  const present = new Set<string>();
  const docker = (args: string[]): string => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'create') return args.at(-1)!;
    if (args[0] === 'run') {
      const nonce = args
        .find((arg) => arg.startsWith(`${COMPILER_NONCE_LABEL}=`))
        ?.slice(`${COMPILER_NONCE_LABEL}=`.length);
      if (nonce) present.add(nonce);
      throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' });
    }
    if (args[0] === 'ps') {
      const nonce = args.at(-1)?.slice(`label=${COMPILER_NONCE_LABEL}=`.length);
      return nonce && present.has(nonce) ? `half-${nonce}` : '';
    }
    if (args[0] === 'rm') {
      for (const nonce of present) if (args.at(-1) === `half-${nonce}`) present.delete(nonce);
    }
    return '';
  };
  expect(() => startCompilerContainer(9, 'nonce-fail', docker, {})).toThrow(/ETIMEDOUT/);
  const runs = calls.filter((args) => args[0] === 'run');
  expect(runs).toHaveLength(2);
  expect(calls[0]).toEqual(compilerDatabaseVolumeCreateArgs(9, 'nonce-fail'));
  expect(calls[2]).toEqual(['ps', '-aq', '--filter', `label=${COMPILER_NONCE_LABEL}=nonce-fail`]);
  expect(calls[3]).toEqual(compilerDatabaseRemoveArgs('half-nonce-fail'));
  const retryNonce = runs[1]!
    .find((arg, index) => runs[1]![index - 1] === '--label' && arg.startsWith(`${COMPILER_NONCE_LABEL}=`))
    ?.slice(`${COMPILER_NONCE_LABEL}=`.length);
  expect(retryNonce).toBeDefined();
  expect(retryNonce).not.toBe('nonce-fail');
  expect(calls).toContainEqual(['ps', '-aq', '--filter', `label=${COMPILER_NONCE_LABEL}=${retryNonce}`]);
  expect(calls).toContainEqual(compilerDatabaseRemoveArgs(`half-${retryNonce}`));
});

test('compiler cleanup retains both retry nonces and removes a late resource from the first create', () => {
  const first = 'nonce-first';
  const attempted: string[] = [];
  const calls: string[][] = [];
  const listings = new Map<string, number>();
  const existing = new Set<string>();
  let retryNonce = '';
  const docker = (args: string[]): string => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'create') return args.at(-1)!;
    if (args[0] === 'run') {
      const nonce = args
        .find((arg) => arg.startsWith(`${COMPILER_NONCE_LABEL}=`))!
        .slice(`${COMPILER_NONCE_LABEL}=`.length);
      if (nonce === first) throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' });
      retryNonce = nonce;
      existing.add('container-retry');
      return 'container-retry';
    }
    if (args[0] === 'ps') {
      const nonce = args.at(-1)!.slice(`label=${COMPILER_NONCE_LABEL}=`.length);
      const index = (listings.get(nonce) ?? 0) + 1;
      listings.set(nonce, index);
      if (nonce === first && index === 1) return '';
      return nonce === first && existing.has('late-first')
        ? 'late-first'
        : nonce === retryNonce && existing.has('container-retry')
          ? 'container-retry'
          : '';
    }
    if (args[0] === 'rm') existing.delete(args.at(-1)!);
    return '';
  };

  const container = startCompilerContainer(9, first, docker, {}, attempted);
  expect(container).toBe('container-retry');
  expect(attempted).toEqual([first, retryNonce]);
  existing.add('late-first');
  settleCompilerDatabaseRemoval(container, 9, docker, attempted);
  expect(existing.size).toBe(0);
  expect(calls).toContainEqual(compilerDatabaseRemoveArgs('late-first'));
  expect(calls).toContainEqual(compilerDatabaseRemoveArgs('container-retry'));
});

test('ordinary compiler cleanup waits for container and volume settlement', () => {
  const calls: string[][] = [];
  const docker = (args: string[]): string => {
    calls.push(args);
    if (args[0] === 'inspect') throw new Error('Error: No such object: owned');
    if (args[0] === 'volume') return '';
    return '';
  };
  settleCompilerDatabaseRemoval('owned', 9, docker);
  expect(calls[0]).toEqual(compilerDatabaseRemoveArgs('owned'));
  expect(calls[1]).toEqual(compilerDatabaseInspectArgs('owned'));
  expect(calls[2]).toEqual(compilerDatabaseVolumeLsArgs(9));
});

test('ordinary compiler cleanup reports a remaining volume without inventing container identity', () => {
  let volumeExists = true;
  const docker = (args: string[]): string => {
    if (args[0] === 'inspect') throw new Error('Error: No such object: owned');
    if (args[0] === 'volume' && args[1] === 'ls') return volumeExists ? 'vol-still-here' : '';
    if (args[0] === 'volume' && args[1] === 'rm') return '';
    return '';
  };
  expect(() => settleCompilerDatabaseRemoval('owned', 9, docker)).toThrow(/volumes remain: vol-still-here/);
  expect(compilerDatabaseVolumeRemoveArgs('vol-still-here')).toEqual(['volume', 'rm', '-f', 'vol-still-here']);
});

test('timeout requests reconcile through exact container and volume evidence', () => {
  const calls: string[][] = [];
  let listed = true;
  const settled = settleDockerAttempt(
    COMPILER_NONCE_LABEL,
    'nonce-timeout',
    [
      { name: COMPILER_PID_LABEL, value: '9' },
      { name: COMPILER_NONCE_LABEL, value: 'nonce-timeout' },
    ],
    (args) => {
      calls.push(args);
      if (args[0] === 'ps') {
        if (args.at(-1) === `label=${COMPILER_NONCE_LABEL}=nonce-timeout`) return listed ? 'container-1' : '';
        listed = false;
        return '';
      }
      if (args[0] === 'rm') throw new Error('docker rm ETIMEDOUT');
      return '';
    },
  );
  expect(settled).toMatchObject({ status: 'settled', attempts: 1, containers: [], volumes: [] });
  expect(settled.status === 'settled' && settled.requestFailures[0]).toContain('docker rm ETIMEDOUT');
  expect(calls.filter((args) => args[0] === 'rm')).toHaveLength(1);
  expect(calls.at(-1)).toEqual([
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=${COMPILER_PID_LABEL}=9`,
    '--filter',
    `label=${COMPILER_NONCE_LABEL}=nonce-timeout`,
  ]);
});

test('remaining resources recover in the same bounded settlement and unavailable Docker stays explicit', () => {
  let visible = true;
  let removals = 0;
  const recovered = settleDockerAttempt(COMPILER_NONCE_LABEL, 'nonce-retry', [], (args) => {
    if (args[0] === 'ps') return visible ? 'container-2' : '';
    if (args[0] === 'rm') {
      removals += 1;
      if (removals === 1) throw new Error('still present after first removal');
      visible = false;
    }
    return '';
  });
  expect(recovered).toMatchObject({ status: 'settled', attempts: 2 });
  expect(removals).toBe(2);

  const unavailable = settleDockerAttempt(COMPILER_NONCE_LABEL, 'nonce-offline', [], () => {
    throw new Error('docker inspect: daemon unavailable');
  });
  expect(unavailable.status).toBe('unsettled');
  if (unavailable.status === 'unsettled') expect(unavailable.error.message).toContain('daemon unavailable');
});

test('known-container timeout accepts only affirmative absence, retaining unavailable inspection', () => {
  const absent = settleDockerContainerRemoval('gone', (args) => {
    if (args[0] === 'rm') throw new Error('docker rm ETIMEDOUT');
    throw new Error('docker inspect gone failed with status 1: Error: No such object: gone');
  });
  expect(absent).toMatchObject({ status: 'settled', attempts: 1 });

  const unknown = settleDockerContainerRemoval('owned', (args) => {
    if (args[0] === 'rm') throw new Error('docker rm ETIMEDOUT');
    throw new Error('docker inspect owned failed with status 1: daemon unavailable');
  });
  expect(unknown.status).toBe('unsettled');
  if (unknown.status === 'unsettled') expect(unknown.error.message).toContain('daemon unavailable');
});

test('a completed native compiler status survives a later cleanup error', () => {
  const printed: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  };
  try {
    expect(keepCompilerStatusAfterCleanup(23, new Error('docker rm ETIMEDOUT'), 'Auth typecheck')).toBe(23);
    expect(printed.join('\n')).toContain('compiler status 23');
    expect(printed.join('\n')).toContain('docker rm ETIMEDOUT');
    expect(keepCompilerStatusAfterCleanup(undefined, new Error('docker rm ETIMEDOUT'), 'Auth typecheck')).toBe(75);
  } finally {
    console.error = original;
  }
});

test('signal-path compiler cleanup stays detached so SIGKILL cannot abort it', () => {
  expect(compilerDatabaseRemoveArgs('owned')).toEqual(['rm', '-f', '-v', 'owned']);
  expect(beginDetachedDockerRm('')).toBeUndefined();
  const source = readFileSync(new URL('./compiler-database.ts', import.meta.url), 'utf8');
  expect(source).toContain('beginDetachedDockerRm(container)');
  expect(source).toContain('remove(false)');
  expect(source).toContain('settleCompilerDatabaseRemoval(container)');
});

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

test('isolated stacks bind a short unix socket directory instead of publishing a host port', () => {
  const published = postgresPublishArgs(4242, ['--network', 'container:pause-stack-1']);
  expect(published).toEqual(['-v', `${isolatedPostgresSocketDir(4242)}:/var/run/postgresql`]);
  expect(isolatedPostgresSocketDir(4242).startsWith('/tmp/rzpg-')).toBe(true);
  expect(postgresPublishArgs(7, [])).toEqual(['-p', '127.0.0.1::5432']);
  expect(postgresReadyProbe('postgres://rezics:rezics@127.0.0.1:5432/rezics?sslmode=disable')).toContain('pg_isready');
  expect(ownerProcessIdentity()).toContain(`PID=${process.pid}`);
});

test('readiness waits for pg_isready in the container and a protocol reply, not a TCP EOF', async () => {
  const calls: string[][] = [];
  let attempts = 0;
  const docker = (args: string[]): string => {
    calls.push(args);
    attempts += 1;
    if (attempts < 2) throw new Error('the database system is starting up');
    return '';
  };
  await waitForPostgresContainer('pg-1', docker, 2_000);
  expect(calls[0]).toEqual(postgresContainerReadyArgs('pg-1'));
  expect(calls[0]).toContain('pg_isready');

  const eof = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    eof.once('error', reject);
    eof.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    let message = '';
    try {
      await waitForPostgresReady(compilerDatabaseListenUrl(String((eof.address() as { port: number }).port)), 900);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/not ready/);
  } finally {
    await new Promise<void>((resolve) => eof.close(() => resolve()));
  }

  const ready = createServer((socket) => {
    socket.on('data', () => {
      socket.write('N');
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    ready.once('error', reject);
    ready.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    await waitForPostgresReady(compilerDatabaseListenUrl(String((ready.address() as { port: number }).port)), 2_000);
  } finally {
    await new Promise<void>((resolve) => ready.close(() => resolve()));
  }
});

test('stale compiler databases whose owner pid is gone are removed with their volumes', () => {
  const calls: string[][] = [];
  let containerVisible = true;
  let volumeVisible = true;
  const docker = (args: string[]): string => {
    calls.push(args);
    if (args[0] === 'ps' && args.includes('--format')) return '2147483647';
    if (args[0] === 'volume' && args[1] === 'ls' && args.includes('--format')) return '2147483647';
    if (args[0] === 'ps' && args.includes('-aq')) return containerVisible ? 'dead-compiler' : '';
    if (args[0] === 'rm') containerVisible = false;
    if (args[0] === 'volume' && args[1] === 'ls') return volumeVisible ? 'dead-volume' : '';
    if (args[0] === 'volume' && args[1] === 'rm') volumeVisible = false;
    return '';
  };
  cleanupStaleCompilerDatabases(docker);
  expect(calls[0]).toEqual([
    'ps',
    '-a',
    '--filter',
    'label=rezics.compiler.pid',
    '--format',
    '{{.Label "rezics.compiler.pid"}}',
  ]);
  expect(calls[1]).toEqual([
    'volume',
    'ls',
    '--filter',
    'label=rezics.compiler.pid',
    '--format',
    '{{.Label "rezics.compiler.pid"}}',
  ]);
  expect(calls).toContainEqual(compilerDatabaseRemoveArgs('dead-compiler'));
  expect(calls).toContainEqual(compilerDatabaseVolumeRemoveArgs('dead-volume'));
});

async function unixEcho(directory: string): Promise<{ path: string; close: () => Promise<void> }> {
  const path = join(directory, 'pg.sock');
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { createServer } from 'node:net';
const server = createServer((socket) => socket.pipe(socket));
server.listen(process.env.ECHO_SOCKET, () => process.stdout.write('READY\\n'));
process.stdin.resume();
const stop = () => { server.close(); process.exit(0); };
process.stdin.on('end', stop);
process.stdin.on('close', stop);
`,
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ECHO_SOCKET: path },
    },
  );
  const ready = await Promise.race([
    new Promise<boolean>((resolve, reject) => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const pump = (): void => {
        void reader.read().then(({ done, value }) => {
          if (done) {
            resolve(buffer.includes('READY'));
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          if (buffer.includes('READY')) {
            resolve(true);
            return;
          }
          pump();
        }, reject);
      };
      pump();
    }),
    child.exited.then(() => false),
  ]);
  if (!ready) throw new Error('unix echo did not start');
  return {
    path,
    close: async () => {
      try {
        void child.stdin.end();
      } catch {
        // Already gone.
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      await child.exited;
    },
  };
}

function burn(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Synchronous CPU work that starves a same-process proxy's event loop.
  }
}

test('an independent forwarder keeps answering a peer while the owner burns CPU', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pg-forward-'));
  fixtures.push(directory);
  chmodSync(directory, 0o700);
  const echo = await unixEcho(directory);
  try {
    const child = await startPostgresForwarder(echo.path);
    try {
      const observer = Bun.spawn(
        [
          process.execPath,
          '-e',
          `import { createConnection } from 'node:net';
const childPort = Number(process.env.CHILD_PORT);
await new Response(process.stdin).text();
const once = (port, ms) => new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write('ping'));
  const timer = setTimeout(() => { socket.destroy(); resolve('timeout'); }, ms);
  socket.on('data', (chunk) => { clearTimeout(timer); socket.end(); resolve(chunk.toString()); });
  socket.on('error', (error) => { clearTimeout(timer); resolve(String(error)); });
});
const childReply = await once(childPort, 400);
if (String(childReply).includes('ping')) process.stdout.write('child-ok\\n');
else process.stdout.write('child-' + childReply + '\\n');
`,
        ],
        {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, CHILD_PORT: String(child.port) },
        },
      );
      observer.stdin.write('go\n');
      void observer.stdin.end();
      burn(500);
      const output = await new Response(observer.stdout).text();
      const err = await new Response(observer.stderr).text();
      expect(await observer.exited, output + err).toBe(0);
      expect(output).toContain('child-ok');
    } finally {
      child.stop();
      await child.child.exited;
    }
  } finally {
    await echo.close();
  }
}, 15_000);

test('docker stdout and stderr are UTF-8 text whether the runtime returns a string or a Buffer', () => {
  expect(dockerProcessText('  abc\n')).toBe('abc');
  expect(dockerProcessText(Buffer.from('  id\n'))).toBe('id');
  expect(dockerProcessText(undefined)).toBe('');
  expect(dockerProcessText(null)).toBe('');
  const combined = retainOriginalAndCleanupFailure(
    new Error('OpenSearch run timed out'),
    new Error('docker rm ETIMEDOUT'),
    'Kernel check failed',
  );
  expect(combined.message).toContain('OpenSearch run timed out');
  expect(combined.message).toContain('docker rm ETIMEDOUT');
  expect(combined.message).toContain('cleanup could not be proven');
  const calls: string[][] = [];
  reapLabeledContainers('rezics.kernel.check.nonce', 'n1', (args) => {
    calls.push(args);
    return args[0] === 'ps' ? 'half-created\n' : '';
  });
  expect(calls[0]).toEqual(['ps', '-aq', '--filter', 'label=rezics.kernel.check.nonce=n1']);
  expect(calls[1]).toEqual(compilerDatabaseRemoveArgs('half-created'));
});

test('Kernel and Auth helpers load at runtime through a typed dynamic import', () => {
  const source = readFileSync(new URL('./compiler-database.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/^import [^;]+ from '\.\.\/services\//m);
  expect(source).toContain('../services/kernel/scripts/database.ts');
  expect(source).toContain('../services/auth/scripts/database.ts');
  expect(source).toContain('../services/kernel/scripts/command-phases.ts');
});

test('the forwarder child exits when the owner closes stdin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pg-forward-exit-'));
  fixtures.push(directory);
  const echo = await unixEcho(directory);
  try {
    const forwarder = await startPostgresForwarder(echo.path);
    expect(forwarder.child.exitCode).toBeNull();
    forwarder.stop();
    expect(await forwarder.child.exited).toBe(0);
  } finally {
    await echo.close();
  }
});
