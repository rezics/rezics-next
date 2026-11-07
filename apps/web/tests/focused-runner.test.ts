import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitExplicitHostTestCommand, admitSerialBunTestCommand, runFocusedCommand } from '../scripts/focused.ts';
import { webTestPrivateNetworkEnvName } from '../scripts/with-dev-server.ts';

const temporary = mkdtempSync(join(tmpdir(), 'rezics-web-focused-test-'));
const workspace = resolve(import.meta.dir, '../..');

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

async function runFocused(appDirectory: string, command: string[]): Promise<{ status: number; output: string }> {
  let output = '';
  const status = await runFocusedCommand(command, {
    appDirectory,
    prepare: () => 0,
    place: async () => null,
    onOutput(_stream, chunk) {
      output += new TextDecoder().decode(chunk);
    },
  });
  return { status, output };
}

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
  expect(admitSerialBunTestCommand(['bun', 'test', 'tests/page-stories.test.ts'])).toEqual([
    'bun',
    'test',
    '--max-concurrency=1',
    'tests/page-stories.test.ts',
  ]);
  expect(admitSerialBunTestCommand(['bun', 'test', '--max-concurrency=2', 'tests/page-stories.test.ts'])).toEqual([
    'bun',
    'test',
    '--max-concurrency=2',
    'tests/page-stories.test.ts',
  ]);
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

test('an explicit nested host file executes when bunfig excludes host discovery', async () => {
  mkdirSync(join(workspace, '.temp'), { recursive: true });
  const project = mkdtempSync(join(workspace, '.temp/focused-host-exec-'));
  try {
    mkdirSync(join(project, 'tests', 'native'), { recursive: true });
    writeFileSync(join(project, 'bunfig.toml'), '[test]\npathIgnorePatterns = ["**/*.host.test.ts"]\n');
    writeFileSync(
      join(project, 'tests', 'ordinary.test.ts'),
      "import { expect, test } from 'bun:test';\ntest('ordinary witness', () => { console.log('ORDINARY_WITNESS_EXECUTED'); expect(1).toBe(1); });\n",
    );
    writeFileSync(
      join(project, 'tests', 'native', 'native-purchases.host.test.ts'),
      "import { expect, test } from 'bun:test';\ntest('nested host witness', () => { console.log('HOST_WITNESS_EXECUTED'); expect(1).toBe(1); });\n",
    );

    const discovery = await runFocused(project, ['bun', 'test']);
    expect(discovery.status, discovery.output).toBe(0);
    expect(discovery.output).toContain('ORDINARY_WITNESS_EXECUTED');
    expect(discovery.output).not.toContain('HOST_WITNESS_EXECUTED');

    const host = await runFocused(project, ['bun', 'test', 'tests/native/native-purchases.host.test.ts']);
    expect(host.status, host.output).toBe(0);
    expect(host.output).not.toContain('did not match any test files');
    expect(host.output).toContain('HOST_WITNESS_EXECUTED');
    expect(host.output).toMatch(/Ran [1-9]\d* tests? across [1-9]\d* files?/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('isolated test files receive shared Vite bindings while a self-hosted journey retains its own server', async () => {
  mkdirSync(join(workspace, '.temp'), { recursive: true });
  const project = mkdtempSync(join(workspace, '.temp/focused-shared-wrap-'));
  try {
    mkdirSync(join(project, 'scripts'), { recursive: true });
    mkdirSync(join(project, 'tests'), { recursive: true });
    writeFileSync(join(project, 'vite.config.ts'), 'export default {};\n');
    writeFileSync(
      join(project, 'scripts', 'with-dev-server.ts'),
      [
        "const separator = process.argv.indexOf('--');",
        'const command = separator < 0 ? process.argv.slice(2) : process.argv.slice(separator + 1);',
        "const env = { ...process.env, WEB_TEST_DEV_SERVER: 'shared-descriptor.json' };",
        "console.log('SHARED_WRAP ' + command.join(' '));",
        "const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit', env });",
        'process.exitCode = await child.exited;',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(project, 'tests', 'one.test.ts'),
      "import { expect, test } from 'bun:test';\ntest('one', () => { console.log('FILE_ONE ' + process.env.WEB_TEST_DEV_SERVER); expect(process.env.WEB_TEST_DEV_SERVER).toBe('shared-descriptor.json'); });\n",
    );
    writeFileSync(
      join(project, 'tests', 'two.test.ts'),
      "import { expect, test } from 'bun:test';\ntest('two', () => { console.log('FILE_TWO ' + process.env.WEB_TEST_DEV_SERVER); expect(process.env.WEB_TEST_DEV_SERVER).toBe('shared-descriptor.json'); });\n",
    );
    writeFileSync(
      join(project, 'tests', 'post-editing.test.ts'),
      "import { expect, test } from 'bun:test';\ntest('self-hosted', () => { console.log('SELF_HOSTED_EXECUTED'); expect(process.env.WEB_TEST_DEV_SERVER).not.toBe('shared-descriptor.json'); });\n",
    );
    const result = await runFocused(project, [
      'bun',
      'test',
      'tests/one.test.ts',
      'tests/post-editing.test.ts',
      'tests/two.test.ts',
    ]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('SHARED_WRAP bun test --max-concurrency=1 tests/one.test.ts');
    expect(result.output).toContain('SHARED_WRAP bun test --max-concurrency=1 tests/two.test.ts');
    expect(result.output.match(/SHARED_WRAP /g)?.length).toBe(2);
    expect(result.output).toContain('FILE_ONE shared-descriptor.json');
    expect(result.output).toContain('FILE_TWO shared-descriptor.json');
    expect(result.output).toContain('SELF_HOSTED_EXECUTED');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('private-network bun test leaves cache prep on the host network', async () => {
  if (process.platform !== 'linux') return;
  mkdirSync(join(workspace, '.temp'), { recursive: true });
  const project = mkdtempSync(join(workspace, '.temp/focused-private-wrap-'));
  try {
    mkdirSync(join(project, 'scripts'), { recursive: true });
    mkdirSync(join(project, 'tests'), { recursive: true });
    writeFileSync(join(project, 'vite.config.ts'), 'export default {};\n');
    writeFileSync(
      join(project, 'scripts', 'with-dev-server.ts'),
      [
        `console.log('PRIVATE_NETWORK ' + process.env.${webTestPrivateNetworkEnvName});`,
        "console.log('WRAPPER ' + process.argv[1]);",
        "const separator = process.argv.indexOf('--');",
        'const command = separator < 0 ? process.argv.slice(2) : process.argv.slice(separator + 1);',
        "const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' });",
        'process.exitCode = await child.exited;',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(project, 'tests', 'one.test.ts'),
      "import { expect, test } from 'bun:test';\ntest('one', () => { expect(true).toBe(true); });\n",
    );
    let output = '';
    const status = await runFocusedCommand(['bun', 'test', 'tests/one.test.ts'], {
      appDirectory: project,
      privateNetwork: true,
      prepare: () => 0,
      place: async () => null,
      onOutput(_stream, chunk) {
        output += new TextDecoder().decode(chunk);
      },
    });
    expect(status, output).toBe(0);
    expect(output).toContain('PRIVATE_NETWORK 1');
    expect(output).toContain('WRAPPER ');
    expect(output).toContain('with-dev-server.ts');
    expect(output).not.toContain('WRAPPER unshare');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('forwards the focused command, uses owned test state, and never requests a stack lease', async () => {
  const leaseDirectory = join(temporary, 'must-not-be-created');
  const output = outputGate('ARGUMENTS:');
  let stateDirectory = '';
  let preparationEnvironment: NodeJS.ProcessEnv | undefined;
  const status = await runFocusedCommand(
    command("console.log('ARGUMENTS:' + JSON.stringify(process.argv.slice(-2)))", ['one argument', 'two']),
    {
      place: async () => null,
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
      place: async () => null,
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
        place: async () => null,
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
    '  place: async () => null,',
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
