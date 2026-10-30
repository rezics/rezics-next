import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureMessagesReady } from './messages-ready.ts';
import { stackRun, testKeepsFiles } from '../../../scripts/stack-run.ts';

export type TestCommandLane = { args: string[]; isolate: boolean };

const testFilePattern = /\.test\.[cm]?[jt]sx?$/u;
const nativeHostPattern = /\.host\.test\.[cm]?[jt]sx?$/u;
const recorderPattern = /(?:^|\/)record-script\.test\.[cm]?[jt]sx?$/u;

export function planTestCommandLanes(appCommand: string[], appDirectory?: string): TestCommandLane[] {
  if (appCommand[0] !== 'bun' || appCommand[1] !== 'test') return [{ args: appCommand.slice(), isolate: true }];

  const selected = appCommand.filter((argument) => testFilePattern.test(argument));
  if (selected.length === 0) {
    if (!appDirectory) return [{ args: appCommand.slice(), isolate: true }];
    const allFiles = listTestFiles(appDirectory);
    const hostFiles = allFiles.filter(isHostLaneTest);
    const isolatedFiles = allFiles.filter((file) => !isHostLaneTest(file));
    const lanes: TestCommandLane[] = [];
    if (isolatedFiles.length) lanes.push({ args: [...appCommand, ...isolatedFiles], isolate: true });
    if (hostFiles.length) lanes.push({ args: [...appCommand, ...hostFiles], isolate: false });
    return lanes.length ? lanes : [{ args: appCommand.slice(), isolate: true }];
  }

  const hostFiles = selected.filter(isHostLaneTest);
  if (hostFiles.length === 0) return [{ args: appCommand.slice(), isolate: true }];
  if (hostFiles.length === selected.length) return [{ args: appCommand.slice(), isolate: false }];
  const hostSet = new Set(hostFiles);
  return [
    { args: appCommand.filter((argument) => !testFilePattern.test(argument) || !hostSet.has(argument)), isolate: true },
    { args: appCommand.filter((argument) => !testFilePattern.test(argument) || hostSet.has(argument)), isolate: false },
  ];
}

function isHostLaneTest(file: string): boolean {
  return nativeHostPattern.test(file) || recorderPattern.test(file);
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
  const testCommand = rawCommand.indexOf('test');
  const command =
    testCommand < 0
      ? rawCommand
      : rawCommand.map((argument, index) => (index > testCommand ? argument.replace(/^apps\/web\//u, '') : argument));

  if (command.length === 0) {
    process.stderr.write('Usage: bun scripts/isolated.ts <command> [arguments...]\n');
    process.exitCode = 2;
    return;
  }

  const app = resolve(import.meta.dir, '..');
  const root = resolve(app, '../..');
  const appCommand =
    command[0] === 'bun' && command[1] === 'test'
      ? command.map((argument, index) =>
          index > 1 && argument.startsWith('apps/web/') ? resolve(root, argument) : argument,
        )
      : command;
  const stateRoot = process.env.WEB_TEST_STATE_DIR;

  process.exitCode = await stackRun(
    {
      label: 'web isolated',
      root,
      cwd: app,
      command: ['bun', 'scripts/isolated.ts', ...command],
      // A state directory or a report the caller names is read back from this machine.
      keepsFiles: stateRoot !== undefined || testKeepsFiles(appCommand),
    },
    async (slotEnvironment) => {
      if (appCommand[0] === 'bun' && appCommand[1] === 'test') {
        const messageCode = ensureMessagesReady(app);
        if (messageCode !== 0) return messageCode;
      }
      const linux = process.platform === 'linux';
      let isolated = false;

      // Docker-backed native receipts and the recorder use the host lane; native Chromium still isolates itself.
      const commands = planTestCommandLanes(appCommand, app);

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
        PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
        REZICS_TEST_RUNTIME: '1',
        WEB_TEST_STATE_DIR: stateRoot ?? join(temporary!, 'cloudflare-state'),
      };
      try {
        let result = 0;
        let interrupted = false;
        for (const run of commands) {
          const privateNetwork = isolated && run.isolate;
          const invocation = privateNetwork
            ? [
                'unshare',
                '--user',
                '--map-root-user',
                '--net',
                'sh',
                '-c',
                'ip link set lo up && exec "$@"',
                'sh',
                ...run.args,
              ]
            : run.args;
          if (linux && run.isolate && !privateNetwork) {
            process.stderr.write(
              'the tests are running on the host network, so host network changes can break browser tests.\n',
            );
          }
          const testEnvironment: NodeJS.ProcessEnv = { ...childEnvironment, ...slotEnvironment };
          testEnvironment.PUBLIC_ORIGIN = 'http://127.0.0.1:3000';
          testEnvironment.REZICS_TEST_RUNTIME = '1';
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
          const child = Bun.spawn(invocation, {
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
  );
}

if (import.meta.main) await main();

export {};
