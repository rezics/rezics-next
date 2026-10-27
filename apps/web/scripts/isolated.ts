import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stackRun, testKeepsFiles } from '../../../scripts/stack-run.ts';

const command = process.argv.slice(2);

if (command.length === 0) {
  process.stderr.write('Usage: bun scripts/isolated.ts <command> [arguments...]\n');
  process.exitCode = 2;
} else {
  const app = resolve(import.meta.dir, '..');
  const root = resolve(app, '../..');
  const stateRoot = process.env.WEB_TEST_STATE_DIR;

  process.exitCode = await stackRun(
    {
      label: 'web isolated',
      root,
      cwd: app,
      command: ['bun', 'scripts/isolated.ts', ...command],
      // A state directory or a report the caller names is read back from this machine.
      keepsFiles: stateRoot !== undefined || testKeepsFiles(command),
    },
    async (slotEnvironment) => {
      const linux = process.platform === 'linux';
      let isolated = false;

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
      const invocation = isolated
        ? [
            'unshare',
            '--user',
            '--map-root-user',
            '--net',
            'sh',
            '-c',
            'ip link set lo up && exec "$@"',
            'sh',
            ...command,
          ]
        : command;

      if (linux && !isolated) {
        process.stderr.write(
          'the tests are running on the host network, so host network changes can break browser tests.\n',
        );
      }

      try {
        const child = Bun.spawn(invocation, {
          env: { ...childEnvironment, ...slotEnvironment },
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        });

        let exited = false;
        const forwarders = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
          const forward = () => {
            if (!exited) child.kill(signal);
          };
          process.on(signal, forward);
          return [signal, forward] as const;
        });

        try {
          return await child.exited;
        } finally {
          exited = true;
          for (const [signal, forward] of forwarders) process.off(signal, forward);
        }
      } finally {
        if (temporary) rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
}

export {};
