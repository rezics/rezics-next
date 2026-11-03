import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitExplicitHostTestCommand, runFocusedCommand } from '../scripts/focused.ts';

const temporary = mkdtempSync(join(tmpdir(), 'rezics-web-focused-test-'));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function command(source: string, args: string[] = []): string[] {
  return [process.execPath, '-e', source, ...args];
}

function outputGate(token: string) {
  let output = '';
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (open = resolve));

  return {
    get output() {
      return output;
    },
    onOutput(_stream: 'stdout' | 'stderr', chunk: Uint8Array) {
      output += new TextDecoder().decode(chunk);
      if (output.includes(token)) open();
    },
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reached,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out waiting for child output ${JSON.stringify(token)}`)),
              20_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

test('named host files use the host-runner path-ignore override', () => {
  expect(admitExplicitHostTestCommand(['bun', 'test', 'tests/pages-workers.host.test.ts'])).toEqual([
    'bun',
    'test',
    '--path-ignore-patterns=node_modules/**',
    'tests/pages-workers.host.test.ts',
  ]);
  expect(admitExplicitHostTestCommand(['bun', 'test', 'tests/page-stories.test.ts'])).toEqual([
    'bun',
    'test',
    'tests/page-stories.test.ts',
  ]);
  expect(
    admitExplicitHostTestCommand([
      'bun',
      'test',
      '--path-ignore-patterns=custom/**',
      'tests/pages-workers.host.test.ts',
    ]),
  ).toEqual(['bun', 'test', '--path-ignore-patterns=custom/**', 'tests/pages-workers.host.test.ts']);
});

test('forwards the focused command, uses owned test state, and never requests a stack lease', async () => {
  const leaseDirectory = join(temporary, 'must-not-be-created');
  const output = outputGate('ARGUMENTS:');
  let stateDirectory = '';
  let preparationEnvironment: NodeJS.ProcessEnv | undefined;
  const status = await runFocusedCommand(
    command("console.log('ARGUMENTS:' + JSON.stringify(process.argv.slice(-2)))", ['one argument', 'two']),
    {
      env: {
        GOAL_TASK_ID: '',
        REZICS_STACK_REMOTE: 'off',
        REZICS_STACK_LEASE: 'on',
        REZICS_STACK_LEASE_DIR: leaseDirectory,
        REZICS_STACK_SLOTS: '1',
      },
      prepare: (_appDirectory, env) => {
        preparationEnvironment = env;
        return 0;
      },
      onStart: (runtime) => (stateDirectory = runtime.stateDirectory),
      onOutput: output.onOutput,
    },
  );

  expect(status).toBe(0);
  expect(output.output).toContain('ARGUMENTS:["one argument","two"]');
  expect(preparationEnvironment?.REZICS_TEST_RUNTIME).toBe('1');
  expect(preparationEnvironment?.WEB_TEST_STATE_DIR).toBe(stateDirectory);
  expect(stateDirectory.startsWith(`${tmpdir()}/`)).toBe(true);
  expect(existsSync(stateDirectory)).toBe(false);
  expect(existsSync(leaseDirectory)).toBe(false);
});

test('keeps simultaneous focused children isolated and cleans each owner after its own stop', async () => {
  const firstReady = outputGate('FIRST_READY');
  const secondOutput = outputGate('SECOND_DONE');
  let firstRuntime: { pid?: number; stateDirectory: string } | undefined;
  let secondStateDirectory = '';
  let firstFinished = false;
  const first = runFocusedCommand(
    command(
      "const fs=require('node:fs'); const path=require('node:path'); const dir=process.env.WEB_TEST_STATE_DIR; fs.writeFileSync(path.join(dir,'first-state'),'kept'); const keepAlive=setInterval(()=>{},60000); process.once('SIGUSR1',()=>{ clearInterval(keepAlive); console.log('FIRST_RELEASED'); process.exit(0) }); console.log('FIRST_READY');",
    ),
    {
      prepare: () => 0,
      onStart: (runtime) => (firstRuntime = runtime),
      onOutput: firstReady.onOutput,
    },
  ).finally(() => (firstFinished = true));

  try {
    await firstReady.wait();
    const firstDirectory = firstRuntime!.stateDirectory;
    expect(existsSync(join(firstDirectory, 'first-state'))).toBe(true);

    const second = await runFocusedCommand(
      command(
        "const fs=require('node:fs'); const path=require('node:path'); const dir=process.env.WEB_TEST_STATE_DIR; fs.writeFileSync(path.join(dir,'second-state'),'private'); console.log('SECOND_DONE');",
      ),
      {
        prepare: () => 0,
        onStart: (runtime) => (secondStateDirectory = runtime.stateDirectory),
        onOutput: secondOutput.onOutput,
      },
    );

    expect(second).toBe(0);
    expect(firstDirectory).not.toBe(secondStateDirectory);
    expect(existsSync(join(firstDirectory, 'first-state'))).toBe(true);
    expect(existsSync(secondStateDirectory)).toBe(false);
    expect(secondOutput.output).toContain('SECOND_DONE');

    process.kill(-firstRuntime!.pid!, 'SIGUSR1');
    expect(await first).toBe(0);
    expect(existsSync(firstDirectory)).toBe(false);
  } finally {
    if (!firstFinished && firstRuntime?.pid) {
      try {
        process.kill(-firstRuntime.pid, 'SIGUSR1');
      } catch {
        // The child may have exited while an assertion was being reported.
      }
      await first;
    }
  }
});

test('forwards a runner signal to its child and removes owned state after shutdown', async () => {
  const runnerPath = pathToFileURL(resolve(import.meta.dir, '../scripts/focused.ts')).href;
  const childSource =
    "const keepAlive=setInterval(()=>{},60000); process.once('SIGTERM',()=>{ clearInterval(keepAlive); console.log('CHILD_SIGNAL'); process.exit(0) }); console.log('CHILD_READY');";
  const wrapperSource = [
    `import { runFocusedCommand } from ${JSON.stringify(runnerPath)};`,
    `process.exitCode = await runFocusedCommand([process.execPath, '-e', ${JSON.stringify(childSource)}], {`,
    '  prepare: () => 0,',
    '  onStart: ({ stateDirectory }) => console.log(`STATE:${stateDirectory}`),',
    '});',
  ].join('\n');
  const ready = outputGate('CHILD_READY');
  let output = '';
  const wrapper = Bun.spawn(command(wrapperSource), {
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const relay = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      output += text;
      ready.onOutput('stdout', chunk);
    }
  };
  const outputRelay = Promise.all([relay(wrapper.stdout), relay(wrapper.stderr)]);

  try {
    await ready.wait();
    process.kill(-wrapper.pid!, 'SIGTERM');
    expect(await wrapper.exited).toBe(143);
    await outputRelay;
    expect(output).toContain('CHILD_SIGNAL');
    const stateDirectory = output.match(/STATE:(.+)/)?.[1]?.trim();
    expect(stateDirectory).toBeTruthy();
    expect(existsSync(stateDirectory!)).toBe(false);
  } finally {
    if (wrapper.exitCode === null) {
      try {
        process.kill(-wrapper.pid!, 'SIGTERM');
      } catch {
        // The wrapper may have exited while an assertion was being reported.
      }
      await wrapper.exited;
    }
    await outputRelay;
  }
});
