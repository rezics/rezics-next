import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureMessagesReady } from './messages-ready.ts';
import { hasWebCheckCustody, routeWebCheck } from './check-placement.ts';

const app = resolve(import.meta.dir, '..');
const signals = [
  ['SIGINT', 2],
  ['SIGTERM', 15],
  ['SIGHUP', 1],
] as const;
const hostTestFile = /\.host\.test\.[cm]?[jt]sx?$/u;

/** bunfig excludes `*.host.test.ts`; named host files use the same CLI override as `test:host`. */
export function admitExplicitHostTestCommand(command: string[]): string[] {
  if (command[0] !== 'bun' || command[1] !== 'test') return command;
  if (
    command.some((argument) => argument === '--path-ignore-patterns' || argument.startsWith('--path-ignore-patterns='))
  )
    return command;
  if (!command.slice(2).some((argument) => hostTestFile.test(argument))) return command;
  return ['bun', 'test', '--path-ignore-patterns=node_modules/**', ...command.slice(2)];
}

export type FocusedRunnerOptions = {
  appDirectory?: string;
  env?: NodeJS.ProcessEnv;
  privateNetwork?: boolean;
  prepare?: (appDirectory: string, env: NodeJS.ProcessEnv) => number | Promise<number>;
  onStart?: (runtime: { pid?: number; stateDirectory: string }) => void;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: Uint8Array) => void;
};

async function prepareFocusedRun(appDirectory: string, env: NodeJS.ProcessEnv): Promise<number> {
  const messages = ensureMessagesReady(appDirectory, env);
  if (messages !== 0) return messages;
  const generated = Bun.spawn(['bun', 'run', 'generate:routes'], {
    cwd: appDirectory,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return generated.exited;
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForProcessGroup(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (processGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

async function stopProcessGroup(child: Bun.Subprocess<'inherit', 'pipe', 'pipe'>): Promise<void> {
  const pid = child.pid;
  if (!pid || !processGroupAlive(pid)) {
    await child.exited;
    return;
  }
  signalProcessGroup(pid, 'SIGTERM');
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) {
    signalProcessGroup(pid, 'SIGKILL');
    await child.exited;
  }
  if (await waitForProcessGroup(pid, 10_000)) return;
  signalProcessGroup(pid, 'SIGKILL');
  if (!(await waitForProcessGroup(pid, 10_000)))
    throw new Error(`Focused command process group ${pid} remains alive after SIGKILL`);
}

/** Routes before preparation or spawn; the physical remote worker retains its independent fixture cleanup. */
export async function runFocusedCommand(command: string[], options: FocusedRunnerOptions = {}): Promise<number> {
  if (command.length === 0) throw new Error('Usage: bun scripts/focused.ts [--private-network] -- <command...>');
  if (options.privateNetwork && process.platform !== 'linux')
    throw new Error('--private-network requires Linux user and network namespaces');

  const appDirectory = resolve(options.appDirectory ?? app);
  if (
    !hasWebCheckCustody(resolve(app, '../..'), appDirectory) &&
    (options.prepare || options.onStart || options.onOutput)
  )
    throw new Error(
      'Focused check unavailable: in-process preparation/start/output hooks require actual remote custody; callbacks cannot be transferred through the finite CLI.',
    );
  const routed = await routeWebCheck(
    {
      root: resolve(app, '../..'),
      cwd: appDirectory,
      command: [
        'bun',
        'scripts/focused.ts',
        ...(options.privateNetwork ? ['--private-network'] : []),
        '--',
        ...command,
      ],
    },
    { ...process.env, ...options.env },
  );
  if (routed !== null) return routed;
  const admitted = admitExplicitHostTestCommand(command);
  const stateDirectory = mkdtempSync(join(tmpdir(), 'rezics-web-focused-'));
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    REZICS_TEST_RUNTIME: '1',
    WEB_TEST_STATE_DIR: stateDirectory,
  };
  const invocation = options.privateNetwork
    ? ['unshare', '--user', '--map-root-user', '--net', 'sh', '-c', 'ip link set lo up && exec "$@"', 'sh', ...admitted]
    : admitted;
  let child: Bun.Subprocess<'inherit', 'pipe', 'pipe'> | undefined;
  let runtimeStopped = false;
  let receivedSignal: NodeJS.Signals | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let outputError: unknown;
  const forwarders: Array<readonly [NodeJS.Signals, () => void]> = [];

  const forward = (signal: NodeJS.Signals) => {
    receivedSignal ??= signal;
    const pid = child?.pid;
    if (pid) signalProcessGroup(pid, signal);
    if (pid) {
      forceTimer ??= setTimeout(() => signalProcessGroup(pid, 'SIGKILL'), 10_000);
      forceTimer.unref?.();
    }
  };
  for (const [signal] of signals) {
    const listener = () => forward(signal);
    process.on(signal, listener);
    forwarders.push([signal, listener]);
  }

  try {
    const prepare = options.prepare ?? prepareFocusedRun;
    const prepared = await prepare(appDirectory, childEnvironment);
    if (receivedSignal) return 128 + signals.find(([signal]) => signal === receivedSignal)![1];
    if (prepared !== 0) return prepared;

    child = Bun.spawn(invocation, {
      cwd: appDirectory,
      env: childEnvironment,
      detached: true,
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const pid = child.pid;
    options.onStart?.({ pid, stateDirectory });

    const relay = async (stream: ReadableStream<Uint8Array>, kind: 'stdout' | 'stderr') => {
      try {
        for await (const chunk of stream) {
          if (options.onOutput) options.onOutput(kind, chunk);
          else (kind === 'stdout' ? process.stdout : process.stderr).write(chunk);
        }
      } catch (error) {
        outputError ??= error;
      }
    };
    const output = Promise.all([relay(child.stdout, 'stdout'), relay(child.stderr, 'stderr')]);
    const status = await child.exited;
    await stopProcessGroup(child);
    runtimeStopped = true;
    await output;
    if (outputError) throw outputError;
    return receivedSignal ? 128 + signals.find(([signal]) => signal === receivedSignal)![1] : status;
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
    for (const [signal, listener] of forwarders) process.off(signal, listener);
    if (child && !runtimeStopped) {
      await stopProcessGroup(child);
      runtimeStopped = true;
    } else if (!child) {
      runtimeStopped = true;
    }
    if (runtimeStopped) rmSync(stateDirectory, { recursive: true, force: true });
  }
}

function parseArguments(args: string[]): { command: string[]; privateNetwork: boolean } {
  const separator = args.indexOf('--');
  if (separator < 0) throw new Error('Usage: bun scripts/focused.ts [--private-network] -- <command...>');
  const flags = args.slice(0, separator);
  if (flags.some((flag) => flag !== '--private-network')) throw new Error(`Unknown option: ${flags.join(' ')}`);
  const command = args.slice(separator + 1);
  if (command.length === 0) throw new Error('Usage: bun scripts/focused.ts [--private-network] -- <command...>');
  return { command, privateNetwork: flags.includes('--private-network') };
}

if (import.meta.main) {
  try {
    const { command, privateNetwork } = parseArguments(process.argv.slice(2));
    process.exitCode = await runFocusedCommand(command, { privateNetwork });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
