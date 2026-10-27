import { resolve } from 'node:path';
import { stackRun, testKeepsFiles } from '../../../scripts/stack-run.ts';
import { fakePrivacyContactUrl } from './fake-auth';

const command = process.argv.slice(2);

if (command.length === 0) {
  process.stderr.write('Usage: bun scripts/isolated.ts <command> [arguments...]\n');
  process.exitCode = 2;
} else {
  const app = resolve(import.meta.dir, '..');

  process.exitCode = await stackRun(
    {
      label: 'auth isolated',
      root: resolve(app, '../..'),
      cwd: app,
      command: ['bun', 'scripts/isolated.ts', ...command],
      // The screenshot script writes the images the caller commits; a report option names a file the caller reads.
      keepsFiles: testKeepsFiles(command) || command.some((argument) => argument.endsWith('scripts/screenshots.ts')),
    },
    async (env) => {
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

      const child = Bun.spawn(invocation, {
        env: {
          ...process.env,
          ...env,
          PRIVACY_CONTACT_URL: process.env.PRIVACY_CONTACT_URL ?? fakePrivacyContactUrl,
        },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });

      let exited = false;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
          if (!exited) child.kill(signal);
        });
      }

      const code = await child.exited;
      exited = true;
      return code;
    },
  );
}

export {};
