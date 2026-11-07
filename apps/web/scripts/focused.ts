import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureMessagesReady } from './messages-ready.ts';
import { hasWebCheckCustody, routeWebCheck } from './check-placement.ts';
import { commandNeedsSharedDevServer, privateNetworkCommand, webTestPrivateNetworkEnvName } from './with-dev-server.ts';
import { ownBunProcess } from '../tests/support/server-custody.ts';
import {
  admitWebHostTestCommand,
  mapWebTestSelector,
  readWebTestSelectionContext,
  resolveWebTestSelection,
  testSelectorArgumentIndices,
  writeWebTestSelectionContext,
  type WebTestSelection,
  type WebTestSelectionContext,
} from './selection.ts';

const app = resolve(import.meta.dir, '..');
const signals = [
  ['SIGINT', 2],
  ['SIGTERM', 15],
  ['SIGHUP', 1],
] as const;

/** bunfig excludes `*.host.test.ts`; named host files use the same CLI override as `test:host`. */
export function admitExplicitHostTestCommand(command: string[]): string[] {
  if (command[0] !== 'bun' || command[1] !== 'test') return command;
  return admitWebHostTestCommand(command);
}

/** Map a named test file onto the focused child's working directory. Option operands stay untouched. */
export function focusedChildTestFile(
  file: string,
  appDirectory: string,
  repoRoot = resolve(appDirectory, '../..'),
): string {
  return mapWebTestSelector(file, appDirectory, repoRoot, appDirectory);
}

/** Canonicalize only explicit test-file selectors; flags and their values keep their original tokens. */
export function focusedChildTestCommand(
  command: string[],
  appDirectory: string,
  repoRoot = resolve(appDirectory, '../..'),
): string[] {
  const selectors = new Set(testSelectorArgumentIndices(command));
  return command.map((argument, index) =>
    selectors.has(index) ? focusedChildTestFile(argument, appDirectory, repoRoot) : argument,
  );
}

/** Explicit files run in fresh runtimes: Bun's module mocks otherwise survive across file boundaries. */
export function focusedTestCommands(command: string[]): string[][] {
  if (command[0] !== 'bun' || command[1] !== 'test') return [command];
  const selectors = testSelectorArgumentIndices(command);
  if (selectors.length < 2) return [command];
  return selectors.map((selectedIndex) =>
    command.filter((_, index) => !selectors.includes(index) || index === selectedIndex),
  );
}

/** One exclusive Worker graph at a time in a focused 6 GiB slot when Copies and signed-in-routes both compile. */
export function admitSerialBunTestCommand(command: string[]): string[] {
  if (command[0] !== 'bun' || command[1] !== 'test') return command;
  if (command.some((argument) => argument === '--max-concurrency' || argument.startsWith('--max-concurrency=')))
    return command;
  return ['bun', 'test', '--max-concurrency=1', ...command.slice(2)];
}

export type FocusedRunnerOptions = {
  appDirectory?: string;
  /** The caller's actual cwd before this command is routed to the owning Web workspace. */
  invocationDirectory?: string;
  env?: NodeJS.ProcessEnv;
  /** Present only when the placed CLI re-enters through its private routing token. */
  selectionContext?: WebTestSelectionContext;
  privateNetwork?: boolean;
  prepare?: (appDirectory: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) => number | Promise<number>;
  onStart?: (runtime: { pid?: number; stateDirectory: string }) => void;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: Uint8Array) => void;
  place?: (run: { root: string; cwd: string; command: string[] }, env: NodeJS.ProcessEnv) => Promise<number | null>;
};

export async function prepareFocusedRun(
  appDirectory: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<number> {
  const messages = await ensureMessagesReady(appDirectory, env, signal === undefined ? {} : { signal });
  if (messages !== 0) return messages;
  const generated = Bun.spawn(['bun', 'run', 'generate:routes'], {
    cwd: appDirectory,
    env,
    detached: true,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const custody = ownBunProcess(generated, {
    label: 'Focused Web route generator',
    termGraceMs: 2_000,
    settleTimeoutMs: 5_000,
  });
  let cleanup: Promise<void> | undefined;
  let cleanupError: unknown;
  const stop = () =>
    (cleanup ??= custody.close().catch((error) => {
      cleanupError = error;
      throw error;
    }));
  const abort = () => {
    void stop().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const status = await generated.exited;
    await stop();
    if (cleanupError) throw cleanupError;
    return status;
  } finally {
    signal?.removeEventListener('abort', abort);
    await stop();
  }
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
  const selection: WebTestSelection = options.selectionContext
    ? {
        ...options.selectionContext,
        executionCwd: appDirectory,
        command: options.selectionContext.normalizedArgv.slice(),
      }
    : resolveWebTestSelection(command, {
        rootDirectory: resolve(appDirectory, '../..'),
        appDirectory,
        invocationDirectory: options.invocationDirectory ?? process.cwd(),
        source: 'apps/web/scripts/focused.ts',
      });
  const routedEnvironment = writeWebTestSelectionContext(selection, { ...process.env, ...options.env });
  if (
    !hasWebCheckCustody(resolve(app, '../..'), appDirectory) &&
    !options.place &&
    (options.prepare || options.onStart || options.onOutput)
  )
    throw new Error(
      'Focused check unavailable: in-process preparation/start/output hooks require actual remote custody; callbacks cannot be transferred through the finite CLI.',
    );
  const place = options.place ?? routeWebCheck;
  const routed = await place(
    {
      root: resolve(appDirectory, '../..'),
      cwd: appDirectory,
      command: [
        'bun',
        'scripts/focused.ts',
        ...(options.privateNetwork ? ['--private-network'] : []),
        '--routed-selection',
      ],
    },
    routedEnvironment,
  );
  if (routed !== null) return routed;
  const admitted = admitSerialBunTestCommand(admitExplicitHostTestCommand(selection.command));
  const wrapShared =
    existsSync(join(appDirectory, 'vite.config.ts')) && existsSync(join(appDirectory, 'scripts/with-dev-server.ts'));
  const stateDirectory = mkdtempSync(join(tmpdir(), 'rezics-web-focused-'));
  const childEnvironment: NodeJS.ProcessEnv = {
    ...routedEnvironment,
    REZICS_TEST_RUNTIME: '1',
    REZICS_WEB_SERIAL_VITE: '1',
    WEB_TEST_STATE_DIR: stateDirectory,
  };
  if (wrapShared && options.privateNetwork) childEnvironment[webTestPrivateNetworkEnvName] = '1';
  for (const name of [
    'AUTH_ISSUER',
    'WEBSITE_CLIENT_ID',
    'WEBSITE_CLIENT_KEY',
    'API_RESOURCE',
    'WEBSITE_SCOPES',
    'SITE_ORIGINS',
    'KERNEL_ORIGIN',
  ])
    delete childEnvironment[name];
  delete childEnvironment.REZICS_WEB_TEST_SELECTION_CONTEXT;
  const invocations = focusedTestCommands(admitted).map((command) =>
    wrapShared && commandNeedsSharedDevServer(command)
      ? ['bun', 'scripts/with-dev-server.ts', '--', ...command]
      : options.privateNetwork
        ? privateNetworkCommand(command)
        : command,
  );
  let child: Bun.Subprocess<'inherit', 'pipe', 'pipe'> | undefined;
  let runtimeStopped = false;
  let receivedSignal: NodeJS.Signals | undefined;
  const preparationAbort = new AbortController();
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let outputError: unknown;
  const forwarders: Array<readonly [NodeJS.Signals, () => void]> = [];

  const forward = (signal: NodeJS.Signals) => {
    receivedSignal ??= signal;
    preparationAbort.abort(signal);
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
    let prepared: number;
    try {
      prepared = await prepare(appDirectory, childEnvironment, preparationAbort.signal);
    } catch (error) {
      if (receivedSignal) return 128 + signals.find(([signal]) => signal === receivedSignal)![1];
      throw error;
    }
    if (receivedSignal) return 128 + signals.find(([signal]) => signal === receivedSignal)![1];
    if (prepared !== 0) return prepared;

    let result = 0;
    for (const invocation of invocations) {
      runtimeStopped = false;
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
      if (receivedSignal) return 128 + signals.find(([signal]) => signal === receivedSignal)![1];
      if (status !== 0 && result === 0) result = status;
    }
    return result;
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

function parseArguments(args: string[]): {
  command: string[];
  privateNetwork: boolean;
  selectionContext?: WebTestSelectionContext;
} {
  if (args.at(-1) === '--routed-selection') {
    const flags = args.slice(0, -1);
    if (flags.some((flag) => flag !== '--private-network')) throw new Error(`Unknown option: ${flags.join(' ')}`);
    const context = readWebTestSelectionContext();
    if (!context) throw new Error('--routed-selection requires the placed Web test selection context');
    return {
      command: context.normalizedArgv.slice(),
      privateNetwork: flags.includes('--private-network'),
      selectionContext: context,
    };
  }
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
    const { command, privateNetwork, selectionContext } = parseArguments(process.argv.slice(2));
    process.exitCode = await runFocusedCommand(command, {
      privateNetwork,
      ...(selectionContext === undefined ? {} : { selectionContext }),
    });
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  }
}
