import { resolve } from 'node:path';
import { routeWebCheck } from '../../../apps/web/scripts/check-placement.ts';

const command = process.argv.slice(2);
const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
if (command.length > 0) {
  const routed = await routeWebCheck({ root, cwd: app, command: ['bun', 'scripts/isolated.ts', ...command] });
  if (routed !== null) process.exit(routed);
}
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

if (command.length === 0) {
  process.stderr.write('Usage: bun scripts/isolated.ts <command> [arguments...]\n');
  process.exitCode = 2;
} else {
  const invocation = isolated
    ? ['unshare', '--user', '--map-root-user', '--net', 'sh', '-c', 'ip link set lo up && exec "$@"', 'sh', ...command]
    : command;

  if (linux && !isolated) {
    process.stderr.write(
      'the tests are running on the host network, so host network changes can break browser tests.\n',
    );
  }

  const child = Bun.spawn(invocation, {
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

  process.exitCode = await child.exited;
  exited = true;
}

export {};
