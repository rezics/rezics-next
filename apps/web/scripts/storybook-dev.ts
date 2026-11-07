import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { ensureMessagesReady } from './messages-ready.ts';
import {
  createWebStartupTraceId,
  listenForWebStartupSignals,
  runWebStartupChild,
  webStartupLog,
  webStartupSelection,
  webStartupSignalExitCode,
  webStartupTraceIdEnvName,
} from './web-startup.ts';

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
    const port = forwarded.some((arg) => arg === '--port' || arg.startsWith('--port=')) ? [] : ['--port', '3000'];
    return {
      // Existing finite test callers of `bun run dev` still require check custody.
      kind: env.REZICS_TEST_RUNTIME === '1' ? 'vite' : 'app',
      command: 'vite',
      cwd: roots.web,
      args: ['--config', 'vite.config.ts', ...port, '--strictPort', ...forwarded],
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

/** Vite must see complete Paraglide modules before it scans routes; generating inside config races SSR of /en. */
export function webServeNeedsGeneratedMessages(kind: LaunchPlan['kind']): boolean {
  return kind === 'app' || kind === 'vite';
}

if (import.meta.main) {
  const traceId = createWebStartupTraceId();
  const startupEnv: NodeJS.ProcessEnv = { ...process.env, [webStartupTraceIdEnvName]: traceId };
  const interruptions = listenForWebStartupSignals();
  try {
    webStartupLog('entry-start', {}, startupEnv);
    let args = process.argv.slice(2);
    if (args.includes('--operator')) {
      const { operatorEntry } = await import('./operator-entry.ts');
      args = operatorEntry(args).args;
    }
    const plan = storybookLaunchPlan(args, startupEnv);
    webStartupLog('binding-selection', webStartupSelection(plan.kind, startupEnv), startupEnv);
    if (plan.kind === 'vite') {
      webStartupLog('check-custody-start', {}, startupEnv);
      const { requireWebCheckCustody } = await import('./web-check-custody.ts');
      requireWebCheckCustody(repoRoot, webRoot);
      webStartupLog('check-custody-complete', {}, startupEnv);
    }

    let generated = 0;
    if (webServeNeedsGeneratedMessages(plan.kind)) {
      const startedAt = performance.now();
      webStartupLog('messages-preparation-start', {}, startupEnv);
      generated = await ensureMessagesReady(webRoot, startupEnv, {
        signal: interruptions.signal,
        traceId,
      });
      webStartupLog(
        'messages-preparation-complete',
        { exit: generated, elapsedMs: Math.round(performance.now() - startedAt) },
        startupEnv,
      );
    }

    if (generated !== 0 && !interruptions.signal.aborted) {
      console.error(`Paraglide generation exited ${generated} before Vite started`);
      process.exitCode = generated;
    } else {
      process.exitCode = await runWebStartupChild(plan.command, plan.args, plan.cwd, {
        env: startupEnv,
        signal: interruptions.signal,
        traceId,
      });
    }
  } catch (error) {
    if (interruptions.signal.aborted) {
      process.exitCode = webStartupSignalExitCode(interruptions.signal);
      webStartupLog('startup-interrupted', { signal: process.exitCode }, startupEnv);
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      process.exitCode = 75;
    }
  } finally {
    interruptions.dispose();
    webStartupLog('entry-exit', { exit: process.exitCode ?? 0 }, startupEnv);
  }
}
