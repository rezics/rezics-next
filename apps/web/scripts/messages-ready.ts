import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';

const PARAGLIDE = 'src/paraglide';
const LOCK_DIRECTORY = '.temp/paraglide-generate.lock';
const LOCK_OWNER = 'pid';
const LOCK_OWNER_GRACE_MS = 2_000;
const LOCK_POLL_MS = 50;
const PER_MESSAGE_IMPORT = /(?:from|import)\s+['"](\.\/messages\/[^'"]+)['"]/g;
/** Vite failed after a partial compile with this exact module missing. */
export const REQUIRED_PER_MESSAGE_MODULE = 'access_account.js';

type MessageOutputState = {
  current: boolean;
  missing: string[];
  stale: string[];
  signature: string;
};

export type MessagePreparationOptions = { signal?: AbortSignal };

/** Relative `./messages/...` modules that the generated barrel imports. */
export function generatedMessageModules(source: string): string[] {
  const modules = new Set<string>();
  PER_MESSAGE_IMPORT.lastIndex = 0;
  for (const match of source.matchAll(PER_MESSAGE_IMPORT)) {
    const specifier = match[1]!;
    modules.add(specifier.endsWith('.js') ? specifier : `${specifier}.js`);
  }
  return [...modules];
}

function catalogueMessageIds(messagesDirectory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(messagesDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const ids = new Set<string>();
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const parsed: unknown = JSON.parse(readFileSync(join(messagesDirectory, name), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    for (const key of Object.keys(parsed)) ids.add(key);
  }
  return [...ids];
}

function newestCatalogueTime(appDirectory: string): number {
  let names: string[];
  try {
    names = readdirSync(join(appDirectory, 'messages'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Number.NEGATIVE_INFINITY;
    throw error;
  }

  return names
    .filter((name) => name.endsWith('.json'))
    .reduce(
      (newest, name) => Math.max(newest, statSync(join(appDirectory, 'messages', name)).mtimeMs),
      Number.NEGATIVE_INFINITY,
    );
}

function statOrMissing(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function outputState(appDirectory: string): MessageOutputState {
  const outputDirectory = join(appDirectory, PARAGLIDE);
  const barrel = join(outputDirectory, 'messages.js');
  const runtime = join(outputDirectory, 'runtime.js');
  const newestMessageTime = newestCatalogueTime(appDirectory);
  const barrelStat = statOrMissing(barrel);
  const runtimeStat = statOrMissing(runtime);
  let barrelSource = '';
  if (barrelStat?.isFile()) barrelSource = readFileSync(barrel, 'utf8');

  const required = new Set([
    'messages.js',
    'runtime.js',
    ...generatedMessageModules(barrelSource),
    ...catalogueMessageIds(join(appDirectory, 'messages')).map((id) => `./messages/${id}.js`),
    `./messages/${REQUIRED_PER_MESSAGE_MODULE}`,
  ]);
  const missing: string[] = [];
  const stale: string[] = [];
  const signature: string[] = [];
  for (const relative of required) {
    const path = join(outputDirectory, relative);
    const stat = relative === 'messages.js' ? barrelStat : relative === 'runtime.js' ? runtimeStat : statOrMissing(path);
    if (!stat?.isFile()) {
      missing.push(relative);
      signature.push(`${relative}:missing`);
      continue;
    }
    signature.push(`${relative}:${stat.mtimeMs}:${stat.size}`);
    if (stat.mtimeMs < newestMessageTime) stale.push(relative);
  }
  return {
    current: missing.length === 0 && stale.length === 0,
    missing,
    stale,
    signature: signature.sort().join('\n'),
  };
}

/**
 * Generated Paraglide output is current only when the barrel, runtime, every imported module and every catalogue
 * leaf are at least as new as every catalogue. A barrel without `messages/access_account.js` is incomplete.
 */
export function messagesCurrent(appDirectory: string): boolean {
  return outputState(appDirectory).current;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function lockOwner(lockPath: string): number | undefined {
  try {
    const owner = Number.parseInt(readFileSync(join(lockPath, LOCK_OWNER), 'utf8').trim(), 10);
    return Number.isInteger(owner) && owner > 0 ? owner : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function staleLock(lockPath: string): boolean {
  const owner = lockOwner(lockPath);
  if (owner !== undefined) return !isProcessAlive(owner);
  const directory = statOrMissing(lockPath);
  return directory === undefined || Date.now() - directory.mtimeMs > LOCK_OWNER_GRACE_MS;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('Paraglide message preparation was aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function waitForLock(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, LOCK_POLL_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal ? abortError(signal) : new DOMException('Paraglide message preparation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Both focused preparation and Vite's serve hook hold this same app-local lock from freshness check through compile. */
export async function withParaglideMessagesLock<T>(
  appDirectory: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lockPath = join(appDirectory, LOCK_DIRECTORY);
  mkdirSync(dirname(lockPath), { recursive: true });
  let acquired = false;
  let waitingSince: number | undefined;
  for (;;) {
    throwIfAborted(signal);
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(join(lockPath, LOCK_OWNER), `${process.pid}\n`, { flag: 'wx' });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (staleLock(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (waitingSince === undefined) {
        waitingSince = Date.now();
        process.stderr.write(`[paraglide] stage=lock wait owner=${lockOwner(lockPath) ?? 'starting'}\n`);
      }
      await waitForLock(signal);
    }
  }
  try {
    if (waitingSince !== undefined)
      process.stderr.write(`[paraglide] stage=lock acquired elapsed-ms=${Date.now() - waitingSince}\n`);
    throwIfAborted(signal);
    return await run();
  } finally {
    if (acquired) rmSync(lockPath, { recursive: true, force: true });
  }
}

function signalForAbort(signal: AbortSignal): NodeJS.Signals {
  const reason = signal.reason;
  if (typeof reason === 'string' && ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(reason)) return reason as NodeJS.Signals;
  return 'SIGTERM';
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 1);
}

async function runGenerator(
  appDirectory: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  onStart: (pid: number | undefined) => void,
): Promise<number> {
  throwIfAborted(signal);
  const child = spawn('bun', ['run', 'generate'], {
    cwd: appDirectory,
    env,
    stdio: 'inherit',
  });
  onStart(child.pid);
  const onAbort = () => child.kill(signal ? signalForAbort(signal) : 'SIGTERM');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, childSignal) => {
        resolve(code ?? (childSignal ? exitCodeForSignal(childSignal) : 1));
      });
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function stateSummary(state: MessageOutputState): string {
  const missing = state.missing.length === 0 ? '' : ` missing=${state.missing.length}(${state.missing.slice(0, 4).join(',')})`;
  const stale = state.stale.length === 0 ? '' : ` stale=${state.stale.length}(${state.stale.slice(0, 4).join(',')})`;
  return `${missing}${stale}` || 'current';
}

/** Prepare complete messages under the shared lock and preserve the generator's exit status and original output. */
export async function ensureMessagesReady(
  appDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  options: MessagePreparationOptions = {},
): Promise<number> {
  return withParaglideMessagesLock(
    appDirectory,
    async () => {
      let attempt = 0;
      let previousSignature: string | undefined;
      for (;;) {
        throwIfAborted(options.signal);
        const before = outputState(appDirectory);
        if (before.current) {
          process.stderr.write(`[paraglide] stage=readiness result=current attempt=${attempt}\n`);
          return 0;
        }
        if (before.signature === previousSignature) {
          throw new Error(`Paraglide generation made no progress; output remains ${stateSummary(before)}`);
        }
        previousSignature = before.signature;
        attempt += 1;
        const startedAt = performance.now();
        let childPid: number | undefined;
        process.stderr.write(`[paraglide] stage=compile attempt=${attempt} start ${stateSummary(before)}\n`);
        const code = await runGenerator(appDirectory, env, options.signal, (pid) => {
          childPid = pid;
          process.stderr.write(`[paraglide] stage=compile attempt=${attempt} pid=${pid ?? 'unknown'}\n`);
        });
        const after = outputState(appDirectory);
        process.stderr.write(
          `[paraglide] stage=compile attempt=${attempt} pid=${childPid ?? 'unknown'} exit=${code} elapsed-ms=${Math.round(performance.now() - startedAt)} ${stateSummary(after)}\n`,
        );
        if (code !== 0) return code;
        if (!after.current && before.signature === after.signature)
          throw new Error(`Paraglide compiler exited successfully without completing output; ${stateSummary(after)}`);
      }
    },
    options.signal,
  );
}
