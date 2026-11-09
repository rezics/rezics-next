/** Process ownership for the real local-stack fixture; no authority or substitute services. */
import { appendFileSync, closeSync, openSync } from 'node:fs';
import {
  detachedGroupTerminal,
  processIdentity,
  terminateDetachedGroup,
  type RunnerIdentity,
} from '../../../scripts/check-custody.ts';

type StartOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  progress?: boolean;
  outputFile?: string;
};

export type StackFixtureChild = {
  name: string;
  child: ReturnType<typeof Bun.spawn>;
  identity: RunnerIdentity;
  output: Promise<{ stdout: string; stderr: string }>;
  settlement?: Promise<void>;
};

function diagnostic(name: string, state: string, started: number, detail = '') {
  console.error(
    `stack: fixture-${name} ${state} utc=${new Date().toISOString()} elapsedMs=${Math.round(performance.now() - started)}${detail}`,
  );
}

/**
 * A command owns its complete detached group, even after the leader exits. Cancellation starts draining every
 * group immediately; close awaits those drains before the caller removes databases, source or the port lease.
 */
export class StackFixtureLifetime {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly children: StackFixtureChild[] = [];
  private readonly started = performance.now();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly handlers: [NodeJS.Signals, () => void][];
  private readonly exit = () => {
    // Last resort for a synchronous runner exit; normal cancellation always awaits positive settlement below.
    for (const { identity } of this.children) {
      if (detachedGroupTerminal(identity)) continue;
      try {
        process.kill(-identity.group, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  };

  constructor(timeoutMs: number) {
    this.timer = setTimeout(() => this.cancel(new Error('Local stack fixture work deadline exceeded')), timeoutMs);
    this.handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
      const handler = () => this.cancel(new Error(`Local stack fixture cancelled by ${signal}`));
      process.on(signal, handler);
      return [signal, handler];
    });
    process.prependOnceListener('exit', this.exit);
  }

  cancel(reason: unknown): void {
    if (this.signal.aborted) return;
    this.controller.abort(reason);
    // Each stop promise is retained and awaited by close, including any failure.
    for (const child of this.children) void this.stop(child).catch(() => {});
  }

  start(name: string, args: string[], options: StartOptions): StackFixtureChild {
    this.signal.throwIfAborted();
    const started = performance.now();
    // Keep the boot/start lower bound if a very short-lived leader exits before procfs admission.
    const parent = processIdentity()!;
    const log = options.outputFile ? openSync(options.outputFile, 'w') : undefined;
    const child = (() => {
      try {
        return Bun.spawn(args, {
          cwd: options.cwd,
          env: options.env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: options.progress && log === undefined ? 'inherit' : 'pipe',
          detached: true,
        });
      } catch (error) {
        if (log !== undefined) closeSync(log);
        throw error;
      }
    })();
    const identity = processIdentity(child.pid) ?? { ...parent, pid: child.pid, group: child.pid };
    const read = async (stream: ReadableStream<Uint8Array>, progress = false): Promise<string> => {
      if (log === undefined) return new Response(stream).text();
      // The live startup journal includes stdout and stderr; phase markers use stderr. Flush each chunk so
      // readiness assertions can read the journal before the long-running stack exits. Retain console progress.
      for await (const chunk of stream) {
        appendFileSync(log, chunk);
        if (progress) process.stderr.write(chunk);
      }
      return '';
    };
    const output = Promise.all([
      read(child.stdout as ReadableStream<Uint8Array>),
      options.progress && log === undefined ? '' : read(child.stderr as ReadableStream<Uint8Array>, options.progress),
    ])
      .then(([stdout, stderr]) => ({ stdout, stderr }))
      .finally(() => {
        if (log !== undefined) closeSync(log);
      });
    // Observe rejected readers immediately, retaining the original promise for settlement.
    void output.catch(() => {});
    const owned = { name, child, identity, output };
    this.children.push(owned);
    diagnostic(name, 'starting', started, ` pid=${child.pid}`);
    return owned;
  }

  async command(name: string, args: string[], options: StartOptions, check = true): Promise<string> {
    const owned = this.start(name, args, options);
    const code = await owned.child.exited;
    // Do not await EOF first: a setup grandchild can inherit the pipes after its parent has exited.
    await this.stop(owned);
    const { stdout } = await owned.output;
    this.signal.throwIfAborted();
    if (check && code !== 0) throw new Error(`Local stack ${name} exited (${code})`);
    return stdout;
  }

  stop(owned: StackFixtureChild): Promise<void> {
    return (owned.settlement ??= (async () => {
      const started = performance.now();
      const result = await terminateDetachedGroup(owned.identity, 1_000);
      await owned.child.exited;
      if (!result.terminal || !detachedGroupTerminal(owned.identity)) {
        diagnostic(owned.name, 'unsettled', started);
        throw new Error(`Local stack ${owned.name} did not settle: ${result.reason ?? 'process group remains'}`);
      }
      await owned.output;
      diagnostic(
        owned.name,
        'settled',
        started,
        ` terminal=true exit=${owned.child.exitCode} signal=${owned.child.signalCode}`,
      );
    })());
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    const results = await Promise.allSettled(this.children.map((child) => this.stop(child)));
    for (const [signal, handler] of this.handlers) process.off(signal, handler);
    process.off('exit', this.exit);
    const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    diagnostic('processes', errors.length ? 'unsettled' : 'settled', this.started, ` groups=${this.children.length}`);
    if (errors.length) throw new AggregateError(errors, 'Local stack fixture process settlement failed');
  }
}

/** Transport readiness consumes the same fixture deadline; cancellation ends fetches and retry waits. */
export async function waitForFixtureResponse(url: string, signal: AbortSignal): Promise<number> {
  for (;;) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { signal });
      await response.body?.cancel();
      if (response.status === 200) return response.status;
    } catch (error) {
      signal.throwIfAborted();
      // A transport refusal may be retried; unexpected errors retain their cause.
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', aborted);
        resolve();
      }, 200);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
}
