import { afterEach, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  COMPILER_NONCE_LABEL,
  COMPILER_PID_LABEL,
  DOCKER_PROBE_TIMEOUT_MS,
  DOCKER_RUN_TIMEOUT_MS,
  cleanupStaleCompilerDatabases,
  compilerDatabaseListenUrl,
  compilerDatabaseRunArgs,
  dockerNetworkArgs,
  dockerSpawnSyncOptions,
  dockerTimeoutMs,
  isolatedPostgresSocketDir,
  ownerProcessIdentity,
  postgresContainerReadyArgs,
  postgresPublishArgs,
  postgresReadyProbe,
  reapCompilerNonce,
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
  expect(dockerTimeoutMs(['exec', 'x', 'pg_isready'])).toBe(DOCKER_PROBE_TIMEOUT_MS);
  expect(dockerTimeoutMs(['ps', '-a'])).toBe(DOCKER_PROBE_TIMEOUT_MS);
  expect(dockerTimeoutMs(['port', 'x', '5432/tcp'])).toBe(DOCKER_PROBE_TIMEOUT_MS);
  const removal = dockerSpawnSyncOptions(['rm', '-f', '-v', 'x']);
  expect(removal.timeout).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(removal.detached).toBe(true);
  const probe = dockerSpawnSyncOptions(['ps', '-aq']);
  expect(probe.timeout).toBe(DOCKER_PROBE_TIMEOUT_MS);
  expect(probe.detached).toBeUndefined();
});

test('the one-run compiler database uses --rm and a labelled volume, not a 1 GiB tmpfs', () => {
  const args = compilerDatabaseRunArgs(9, 'nonce-9', []);
  expect(args[0]).toBe('run');
  expect(args).toContain('--rm');
  expect(args).toContain('--stop-timeout');
  expect(args).toContain(`${COMPILER_PID_LABEL}=9`);
  expect(args).toContain(`${COMPILER_NONCE_LABEL}=nonce-9`);
  expect(args).toContain('--mount');
  expect(args).toContain(`type=volume,destination=/var/lib/postgresql,volume-label=${COMPILER_PID_LABEL}=9`);
  expect(args).not.toContain('--tmpfs');
  expect(args).toContain('-p');
});

test('a failed docker run reaps the nonce before the error escapes', () => {
  const calls: string[][] = [];
  const docker = (args: string[]): string => {
    calls.push(args);
    if (args[0] === 'run') {
      throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' });
    }
    return args[0] === 'ps' ? 'created-unstarted' : '';
  };
  expect(() => startCompilerContainer(9, 'nonce-fail', docker, {})).toThrow(/ETIMEDOUT/);
  expect(calls[0]![0]).toBe('run');
  expect(calls[1]).toEqual(['ps', '-aq', '--filter', `label=${COMPILER_NONCE_LABEL}=nonce-fail`]);
  expect(calls[2]).toEqual(['rm', '-f', '-v', 'created-unstarted']);
  reapCompilerNonce('already-gone', 9, () => {
    throw new Error('daemon timeout');
  });
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
  const docker = (args: string[]): string => {
    calls.push(args);
    return args[0] === 'ps' ? 'dead-compiler 2147483647' : '';
  };
  cleanupStaleCompilerDatabases(docker);
  expect(calls[0]).toEqual([
    'ps',
    '-a',
    '--filter',
    'label=rezics.compiler.pid',
    '--format',
    '{{.ID}} {{.Label "rezics.compiler.pid"}}',
  ]);
  expect(calls[1]).toEqual(['rm', '-f', '-v', 'dead-compiler']);
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
