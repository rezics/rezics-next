import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureMessagesReady } from './messages-ready.ts';
import { stackRun, testKeepsFiles } from '../../../scripts/stack-run.ts';
import { commandNeedsSharedDevServer, privateNetworkCommand, webTestPrivateNetworkEnvName } from './with-dev-server.ts';
import {
  admitWebHostTestCommand,
  appendTestFiles,
  isWebHostTestFile,
  readWebTestSelectionContext,
  resolveWebTestSelection,
  selectedWebTestFiles,
  testCommandOptions,
  testCommandForFiles,
  writeWebTestSelectionContext,
  webTestSelectionContextEnvironment,
  type WebTestSelection,
  type WebTestSelectionContext,
} from './selection.ts';

export type TestCommandLane = { args: string[]; isolate: boolean };

const testFilePattern = /\.test\.[cm]?[jt]sx?$/u;
const authHostFile = 'tests/auth-binding.host.test.ts';
const recorderPattern = /(?:^|\/)record-script\.test\.[cm]?[jt]sx?$/u;

export function planTestCommandLanes(
  appCommand: string[],
  appDirectory?: string,
  selection?: WebTestSelectionContext,
  invocationDirectory = appDirectory ?? process.cwd(),
): TestCommandLane[] {
  if (appCommand[0] !== 'bun' || appCommand[1] !== 'test') return [{ args: appCommand.slice(), isolate: true }];

  const resolved =
    appDirectory && !selection
      ? resolveWebTestSelection(appCommand, {
          rootDirectory: resolve(appDirectory, '../..'),
          appDirectory,
          invocationDirectory,
          source: 'apps/web/scripts/isolated.ts',
        })
      : undefined;
  const command = selection?.normalizedArgv.slice() ?? resolved?.command ?? appCommand.slice();
  const selected = selection?.selectedFiles.slice() ?? resolved?.selectedFiles ?? selectedWebTestFiles(command);
  if (selected.length === 0) {
    if (!appDirectory) return [{ args: appCommand.slice(), isolate: true }];
    const allFiles = listTestFiles(appDirectory).sort();
    const authFiles = allFiles.filter((file) => file === authHostFile);
    const hostFiles = allFiles.filter((file) => isHostLaneTest(file) && file !== authHostFile);
    const isolatedFiles = allFiles.filter((file) => !isHostLaneTest(file));
    const lanes: TestCommandLane[] = [];
    if (isolatedFiles.length) lanes.push({ args: appendTestFiles(command, isolatedFiles), isolate: true });
    if (authFiles.length)
      lanes.push({
        args: ['bun', 'scripts/check.ts', '--auth-binding-host', ...testCommandOptions(command)],
        isolate: false,
      });
    if (hostFiles.length)
      lanes.push({ args: admitWebHostTestCommand(appendTestFiles(command, hostFiles)), isolate: false });
    return lanes.length ? lanes : [{ args: command, isolate: true }];
  }

  const authFiles = selected.filter((file) => file === authHostFile);
  const hostFiles = selected.filter((file) => isHostLaneTest(file) && file !== authHostFile);
  const isolatedFiles = selected.filter((file) => !isHostLaneTest(file));
  const lanes: TestCommandLane[] = [];
  if (isolatedFiles.length) lanes.push({ args: testCommandForFiles(command, isolatedFiles), isolate: true });
  if (authFiles.length)
    lanes.push({
      args: ['bun', 'scripts/check.ts', '--auth-binding-host', ...testCommandOptions(command)],
      isolate: false,
    });
  if (hostFiles.length)
    lanes.push({
      args: admitWebHostTestCommand(testCommandForFiles(command, hostFiles)),
      isolate: false,
    });
  return lanes.length ? lanes : [{ args: command, isolate: true }];
}

function isHostLaneTest(file: string): boolean {
  return isWebHostTestFile(file) || recorderPattern.test(file);
}

function listTestFiles(directory: string, parent = ''): string[] {
  return readdirSync(join(directory, parent), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') return [];
      return listTestFiles(directory, join(parent, entry.name));
    }
    if (entry.isFile() && testFilePattern.test(entry.name)) return [join(parent, entry.name)];
    return [];
  });
}

async function main(): Promise<void> {
  const rawCommand = process.argv.slice(2);
  const existingContext = readWebTestSelectionContext();
  const routed = rawCommand.length === 1 && rawCommand[0] === '--routed-selection';
  if (routed && !existingContext) throw new Error('--routed-selection requires the placed Web test selection context');
  const command = routed ? existingContext!.normalizedArgv.slice() : rawCommand;

  if (command.length === 0) {
    process.stderr.write('Usage: bun scripts/isolated.ts <command> [arguments...]\n');
    process.exitCode = 2;
    return;
  }

  const app = resolve(import.meta.dir, '..');
  const root = resolve(app, '../..');
  const selection: WebTestSelection | undefined =
    command[0] === 'bun' && command[1] === 'test'
      ? routed && existingContext
        ? { ...existingContext, executionCwd: app, command: existingContext.normalizedArgv.slice() }
        : resolveWebTestSelection(command, {
            rootDirectory: root,
            appDirectory: app,
            invocationDirectory: process.cwd(),
            source: 'apps/web/scripts/isolated.ts',
          })
      : undefined;
  const appCommand = selection?.command ?? command;
  const stateRoot = process.env.WEB_TEST_STATE_DIR;
  const routedCommand = selection
    ? ['bun', 'scripts/isolated.ts', '--routed-selection']
    : ['bun', 'scripts/isolated.ts', ...command];
  const stackEnvironment = selection ? writeWebTestSelectionContext(selection) : process.env;

  process.exitCode = await stackRun(
    {
      label: 'web isolated',
      root,
      cwd: app,
      command: routedCommand,
      // A state directory or a report the caller names is read back from this machine.
      keepsFiles: stateRoot !== undefined || testKeepsFiles(appCommand),
    },
    async (slotEnvironment) => {
      if (appCommand[0] === 'bun' && appCommand[1] === 'test') {
        const messageCode = await ensureMessagesReady(app, slotEnvironment);
        if (messageCode !== 0) return messageCode;
      }
      const linux = process.platform === 'linux';
      let isolated = false;

      // Docker-backed native receipts and the recorder use the host lane; native Chromium still isolates itself.
      const commands = planTestCommandLanes(appCommand, app, selection, selection?.invocationCwd ?? process.cwd());

      if (linux) {
        try {
          isolated =
            Bun.spawnSync(['unshare', '--user', '--map-root-user', '--net', 'ip', 'link', 'set', 'lo', 'up'], {
              stdin: 'ignore',
              stdout: 'ignore',
              stderr: 'ignore',
            }).exitCode === 0;
        } catch {
          isolated = false;
        }
      }

      let temporary: string | undefined;
      if (!stateRoot) temporary = mkdtempSync(join(tmpdir(), 'rezics-web-test-'));
      const childEnvironment = {
        ...process.env,
        ...stackEnvironment,
        PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
        REZICS_TEST_RUNTIME: '1',
        WEB_TEST_STATE_DIR: stateRoot ?? join(temporary!, 'cloudflare-state'),
      };
      try {
        let result = 0;
        let interrupted = false;
        for (const run of commands) {
          const privateNetwork = isolated && run.isolate;
          const wrapShared = commandNeedsSharedDevServer(run.args);
          const args = wrapShared ? ['bun', 'scripts/with-dev-server.ts', '--', ...run.args] : run.args;
          const invocation = privateNetwork && !wrapShared ? privateNetworkCommand(args) : args;
          if (linux && run.isolate && !privateNetwork) {
            process.stderr.write(
              'the tests are running on the host network, so host network changes can break browser tests.\n',
            );
          }
          const testEnvironment: NodeJS.ProcessEnv = { ...childEnvironment, ...slotEnvironment };
          testEnvironment.PUBLIC_ORIGIN = 'http://127.0.0.1:3000';
          testEnvironment.REZICS_TEST_RUNTIME = '1';
          if (wrapShared && privateNetwork) testEnvironment[webTestPrivateNetworkEnvName] = '1';
          for (const name of [
            'AUTH_ISSUER',
            'WEBSITE_CLIENT_ID',
            'WEBSITE_CLIENT_KEY',
            'API_RESOURCE',
            'WEBSITE_SCOPES',
            'SITE_ORIGINS',
            'KERNEL_ORIGIN',
          ])
            delete testEnvironment[name];
          if (run.args[0] === 'bun' && run.args[1] === 'test')
            delete testEnvironment[webTestSelectionContextEnvironment];
          const child = Bun.spawn(invocation, {
            cwd: app,
            env: testEnvironment,
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
          });

          let exited = false;
          const forwarders = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
            const forward = () => {
              interrupted = true;
              if (!exited) child.kill(signal);
            };
            process.on(signal, forward);
            return [signal, forward] as const;
          });

          try {
            const code = await child.exited;
            if (result === 0) result = code;
          } finally {
            exited = true;
            for (const [signal, forward] of forwarders) process.off(signal, forward);
          }
          if (interrupted) break;
        }
        return result;
      } finally {
        if (temporary) rmSync(temporary, { recursive: true, force: true });
      }
    },
    stackEnvironment,
  );
}

if (import.meta.main) await main();

export {};
