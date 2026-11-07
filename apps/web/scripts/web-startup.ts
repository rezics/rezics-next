import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants as osConstants } from 'node:os';
import type { PluginOption } from 'vite';

export const webStartupTraceIdEnvName = 'REZICS_WEB_STARTUP_TRACE_ID';

const startupSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const tracedPluginHooks = new Set([
  'config',
  'configResolved',
  'configEnvironment',
  'configEnvironmentResolved',
  'configureServer',
  'buildStart',
]);
const maximumEvidenceEvents = 384;
let evidenceEvents = 0;
let evidenceLimitReported = false;

type EvidenceValue = string | number | boolean | undefined;
type EvidenceFields = Record<string, EvidenceValue>;

function evidenceToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/@:+-]/g, '_').slice(0, 120) || 'empty';
}

export function createWebStartupTraceId(pid = process.pid, startedAt = Date.now()): string {
  return `web-${pid}-${startedAt.toString(36)}`;
}

export function webStartupTraceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env[webStartupTraceIdEnvName];
  return id && /^[a-zA-Z0-9._-]{1,80}$/.test(id) ? id : undefined;
}

export function webStartupMode(value: string | undefined): string {
  if (value === undefined) return 'unset';
  return value === 'development' || value === 'production' || value === 'test' ? value : 'other';
}

/** Record only bounded, nonsecret startup facts; environment values are reduced to explicit flags by callers. */
export function webStartupLog(stage: string, fields: EvidenceFields = {}, env: NodeJS.ProcessEnv = process.env): void {
  const traceId = webStartupTraceId(env);
  if (!traceId) return;
  if (evidenceEvents >= maximumEvidenceEvents) {
    if (!evidenceLimitReported) {
      evidenceLimitReported = true;
      process.stderr.write(`[web-startup] trace=${traceId} pid=${process.pid} stage=evidence-limit outcome=reached\n`);
    }
    return;
  }
  evidenceEvents += 1;
  const details = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${evidenceToken(key)}=${evidenceToken(String(value))}`)
    .join(' ');
  process.stderr.write(
    `[web-startup] trace=${traceId} pid=${process.pid} stage=${evidenceToken(stage)}${details ? ` ${details}` : ''}\n`,
  );
}

export function webStartupSelection(kind: string, env: NodeJS.ProcessEnv = process.env): EvidenceFields {
  return {
    kind,
    nodeEnv: webStartupMode(env.NODE_ENV),
    testRuntime: env.REZICS_TEST_RUNTIME === '1' ? 'enabled' : 'disabled',
    walkSlot: env.REZICS_WALK_STACK_SLOT ? 'selected' : 'unset',
    cache: env.WEB_VITE_CACHE_DIR ? 'provided' : 'default',
    cloudflareLocal: env.CLOUDFLARE_VITE_FORCE_LOCAL === 'true' ? 'enabled' : 'unset',
    cloudflareFetch: env.CLOUDFLARE_CF_FETCH_ENABLED === 'false' ? 'disabled' : 'configured',
    nativeTls: env.NATIVE_WEB_TEST_HOST || env.NATIVE_WEB_TEST_TLS_CERT || env.NATIVE_WEB_TEST_TLS_KEY ? 'enabled' : 'disabled',
  };
}

export function webStartupSignalName(signal: AbortSignal): NodeJS.Signals {
  const reason = signal.reason;
  return typeof reason === 'string' && startupSignals.includes(reason as (typeof startupSignals)[number])
    ? (reason as NodeJS.Signals)
    : 'SIGTERM';
}

export function webStartupSignalExitCode(signal: AbortSignal): number {
  return 128 + (osConstants.signals[webStartupSignalName(signal)] ?? 1);
}

export function listenForWebStartupSignals(): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const listeners = startupSignals.map((signal) => {
    const listener = () => controller.abort(signal);
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, listener] of listeners) process.off(signal, listener);
    },
  };
}

function expectedLookupFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return ['EACCES', 'ENOENT', 'ENOTDIR'].includes(String(error.code));
}

function executableCandidates(command: string, cwd: string, env: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return [resolve(cwd, command)];
  const extensions =
    process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  return (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => join(directory, `${command}${extension}`)));
}

function resolveExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const candidate of executableCandidates(command, cwd, env)) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch (error) {
      if (!expectedLookupFailure(error)) throw error;
    }
  }
  return undefined;
}

function executableIdentity(executable: string | undefined): { packageId: string; entry: string } {
  if (!executable) return { packageId: 'unresolved', entry: 'unresolved' };
  let current = dirname(executable);
  for (;;) {
    const manifestPath = join(current, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string };
      if (manifest.name && manifest.version) {
        const entry = relative(current, executable).split(sep).join('/') || basename(executable);
        return { packageId: `${manifest.name}@${manifest.version}`, entry };
      }
    } catch (error) {
      if (!expectedLookupFailure(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return { packageId: `external:${basename(executable)}`, entry: basename(executable) };
    current = parent;
  }
}

export type WebStartupChildOptions = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  traceId?: string;
};

/** Spawn one Vite or Storybook executable and settle its direct child before returning its status. */
export async function runWebStartupChild(
  command: string,
  args: string[],
  cwd: string,
  options: WebStartupChildOptions = {},
): Promise<number> {
  const env = { ...(options.env ?? process.env) };
  const traceId = options.traceId ?? webStartupTraceId(env);
  if (traceId) env[webStartupTraceIdEnvName] = traceId;
  const signal = options.signal;
  if (signal?.aborted) return webStartupSignalExitCode(signal);

  const executable = resolveExecutable(command, cwd, env);
  const identity = executableIdentity(executable);
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([command, ...args], {
      cwd,
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
  } catch (error) {
    webStartupLog('child-spawn', {
      outcome: 'failed',
      command,
      package: identity.packageId,
      entry: identity.entry,
      runtime: `bun@${Bun.version}`,
    }, env);
    throw error;
  }

  const childPid = child.pid;
  webStartupLog('child-start', {
    outcome: 'started',
    command,
    package: identity.packageId,
    entry: identity.entry,
    runtime: `bun@${Bun.version}`,
    parentPid: process.pid,
    childPid: childPid ?? 'unknown',
  }, env);
  const onAbort = () => {
    const stopSignal = signal ? webStartupSignalName(signal) : 'SIGTERM';
    webStartupLog('child-signal', { childPid: childPid ?? 'unknown', signal: stopSignal }, env);
    child.kill(stopSignal);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  let status: number | undefined;
  try {
    status = await child.exited;
    return signal?.aborted ? webStartupSignalExitCode(signal) : status;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    webStartupLog('child-exit', {
      childPid: childPid ?? 'unknown',
      outcome: status === undefined ? 'error' : 'settled',
      exit: status ?? 'unknown',
      interrupted: signal?.aborted ? webStartupSignalName(signal) : 'no',
    }, env);
  }
}

type TraceHook = (this: unknown, ...args: unknown[]) => unknown;

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function tracedHook(pluginName: string, hookName: string, hook: TraceHook): TraceHook {
  const invoke = (suffix: string, current: TraceHook): TraceHook =>
    function (this: unknown, ...args: unknown[]) {
      webStartupLog('plugin-hook', { plugin: pluginName, hook: `${hookName}${suffix}`, outcome: 'start' });
      let result: unknown;
      try {
        result = current.apply(this, args);
      } catch (error) {
        webStartupLog('plugin-hook', { plugin: pluginName, hook: `${hookName}${suffix}`, outcome: 'error' });
        throw error;
      }
      const completed = (value: unknown): unknown => {
        webStartupLog('plugin-hook', { plugin: pluginName, hook: `${hookName}${suffix}`, outcome: 'complete' });
        if (hookName === 'configureServer' && typeof value === 'function' && suffix === '') {
          return invoke(':post', value as TraceHook);
        }
        return value;
      };
      if (promiseLike(result))
        return Promise.resolve(result).then(completed, (error: unknown) => {
          webStartupLog('plugin-hook', { plugin: pluginName, hook: `${hookName}${suffix}`, outcome: 'error' });
          throw error;
        });
      return completed(result);
    };

  return invoke('', hook);
}

function tracePluginOption(option: PluginOption): PluginOption {
  if (Array.isArray(option)) return option.map(tracePluginOption);
  if (!option || typeof option !== 'object') return option;
  if ('then' in option && typeof option.then === 'function') {
    return Promise.resolve(option as PromiseLike<PluginOption>).then(tracePluginOption);
  }
  const pluginName = 'name' in option && typeof option.name === 'string' ? option.name : 'unnamed-plugin';
  return new Proxy(option, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || !tracedPluginHooks.has(key)) return value;
      if (typeof value === 'function') return tracedHook(pluginName, key, value as TraceHook);
      if (typeof value !== 'object' || value === null || !('handler' in value)) return value;
      const handler = value.handler;
      if (typeof handler !== 'function') return value;
      return { ...value, handler: tracedHook(pluginName, key, handler as TraceHook) };
    },
  });
}

/** Preserve Vite's plugin order while tracing the first unfinished config or environment hook. */
export function traceWebVitePlugins<T extends PluginOption[]>(plugins: T): T {
  if (!webStartupTraceId()) return plugins;
  return plugins.map(tracePluginOption) as T;
}
