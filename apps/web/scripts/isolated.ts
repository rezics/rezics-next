import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stackRun, testKeepsFiles } from '../../../scripts/stack-run.ts';

const command = process.argv.slice(2);

if (command.length === 0) {
  process.stderr.write('Usage: bun scripts/isolated.ts <command> [arguments...]\n');
  process.exitCode = 2;
} else {
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
      command: ['bun', 'scripts/isolated.ts', ...appCommand],
      // A state directory or a report the caller names is read back from this machine.
      keepsFiles: stateRoot !== undefined || testKeepsFiles(appCommand),
    },
    async (slotEnvironment) => {
      const linux = process.platform === 'linux';
      let isolated = false;

      // Only the recorder needs Docker's host-published ports. Keep browser tests in their own namespace even when
      // the same Bun invocation names both kinds of test.
      const recorder = (argument: string) => argument.endsWith('record-script.test.ts');
      const testFiles = appCommand.filter((argument) => /\.test\.[cm]?[jt]sx?$/.test(argument));
      const mixed = appCommand[1] === 'test' && testFiles.some(recorder) && testFiles.some((file) => !recorder(file));
      const defaultRecorder =
        appCommand[1] === 'test' && appCommand.length === 2
          ? ['tests/record-script.test.ts', 'apps/web/tests/record-script.test.ts', 'record-script.test.ts'].find(
              existsSync,
            )
          : undefined;
      const commands = mixed
        ? [
            { args: appCommand.filter((argument) => !recorder(argument)), isolate: true },
            {
              args: appCommand.filter((argument) => !testFiles.includes(argument) || recorder(argument)),
              isolate: false,
            },
          ]
        : defaultRecorder
          ? [
              { args: [...appCommand, '--path-ignore-patterns=**/record-script.test.ts'], isolate: true },
              { args: [appCommand[0]!, 'test', `./${defaultRecorder}`], isolate: false },
            ]
          : [{ args: appCommand, isolate: !appCommand.some(recorder) }];

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
      if (!stateRoot) {
        mkdirSync(join(root, '.temp'), { recursive: true });
        temporary = mkdtempSync(join(root, '.temp/web-test-'));
      }
      const childEnvironment = {
        ...process.env,
        PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000',
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
          if (linux && !privateNetwork) {
            process.stderr.write(
              'the tests are running on the host network, so host network changes can break browser tests.\n',
            );
          }
          const child = Bun.spawn(invocation, {
            env: { ...childEnvironment, ...slotEnvironment },
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

export {};
