import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { requireWebCheckCustody } from './check-placement.ts';

const webRoot = resolve(import.meta.dir, '..');
const repoRoot = resolve(webRoot, '../..');
const uiRoot = resolve(repoRoot, 'packages/ui');

type LaunchPlan =
  | { kind: 'vite' | 'app'; command: string; cwd: string; args: string[] }
  | { kind: 'storybook'; command: string; cwd: string; args: string[] };

function isLoopbackHost(host: string): boolean {
  const address = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return (
    address.toLowerCase() === 'localhost' ||
    (isIP(address) === 4 && address.startsWith('127.')) ||
    (isIP(address) === 6 && address.toLowerCase() === '::1')
  );
}

function storybookHosts(args: string[]): string[] {
  const hosts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--host') {
      const host = args[index + 1];
      if (!host || host.startsWith('--')) throw new Error('--host requires a loopback address.');
      hosts.push(host);
      index += 1;
    } else if (arg.startsWith('--host=')) {
      hosts.push(arg.slice('--host='.length));
    }
  }
  return hosts;
}

export function storybookLaunchPlan(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  roots: { web: string; ui: string } = { web: webRoot, ui: uiRoot },
): LaunchPlan {
  if (args[0] === '--app') {
    const forwarded = args.slice(1);
    const hosts = storybookHosts(forwarded);
    for (const host of hosts) {
      if (!isLoopbackHost(host)) {
        throw new Error(`Local Web may bind only to a loopback address; received "${host}".`);
      }
    }
    if (hosts.length === 0) forwarded.push('--host', '127.0.0.1');
    return {
      // Existing finite test callers of `bun run dev` still require check custody.
      kind: env.REZICS_TEST_RUNTIME === '1' ? 'vite' : 'app',
      command: 'vite',
      cwd: roots.web,
      args: ['--config', 'vite.config.ts', '--port', '3000', '--strictPort', ...forwarded],
    };
  }

  if (args[0] === '--web') {
    if (env.REZICS_TEST_RUNTIME !== '1') {
      throw new Error(
        'This entry point only starts Vite for finite test commands; use bun run dev for the local app or bun run storybook for interface development.',
      );
    }
    return {
      kind: 'vite',
      command: 'vite',
      cwd: roots.web,
      args: ['--config', 'vite.config.ts', ...args.slice(1)],
    };
  }

  const ui = args.includes('--ui');
  const forwarded = args.filter((arg) => arg !== '--ui');
  const hosts = storybookHosts(forwarded);
  for (const host of hosts) {
    if (!isLoopbackHost(host)) {
      throw new Error(`Storybook may bind only to a loopback address; received "${host}".`);
    }
  }
  if (hosts.length === 0) forwarded.push('--host', '127.0.0.1');

  return {
    kind: 'storybook',
    command: 'storybook',
    cwd: ui ? roots.ui : roots.web,
    args: ['dev', '--config-dir', '.storybook', ...forwarded],
  };
}

async function runChild(command: string, args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const forwarders = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const forward = () => child.kill(signal);
    process.on(signal, forward);
    return [signal, forward] as const;
  });
  try {
    process.exitCode = await child.exited;
  } finally {
    for (const [signal, forward] of forwarders) process.off(signal, forward);
  }
}

if (import.meta.main) {
  try {
    const plan = storybookLaunchPlan(process.argv.slice(2));
    if (plan.kind === 'vite') requireWebCheckCustody(repoRoot, webRoot);
    await runChild(plan.command, plan.args, plan.cwd);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 75;
  }
}
