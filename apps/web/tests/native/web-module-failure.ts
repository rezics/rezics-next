import { inspectNativeProcess } from './lifecycle.ts';
import type { WebDocumentModules } from './web-document-modules.ts';
import type { NativeMemoryObservation } from './native-memory.ts';

export type WebModuleFailure = {
  phase: 'upstream-fetch' | 'upstream-body' | 'upstream-response';
  upstreamStatus: number | undefined;
  elapsedMs: number;
  error?: unknown;
};

export type WebModuleFailureTrace = {
  origin: string;
  document?: WebDocumentModules;
  report(failure: WebModuleFailure): void;
};

export function transportError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return error.name;
  for (const value of [error, error.cause]) {
    const code = (value as NodeJS.ErrnoException | undefined)?.code;
    if (
      typeof code === 'string' &&
      /^(?:ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EMFILE|ENFILE|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/u.test(
        code,
      )
    )
      return code;
  }
  return 'unclassified';
}

export function traceWebModuleFailure(
  web: string,
  ready: NativeMemoryObservation | null | undefined,
): WebModuleFailureTrace {
  const origin = new URL(web).origin;
  const processes = (ready?.processes.rows ?? [])
    .filter(
      (row) =>
        row.role === 'web-worker' &&
        (row.kind === 'root' || row.name === 'workerd' || row.name === 'node' || row.name === 'node-MainThread'),
    )
    .slice(0, 6);
  let reported = false;
  return {
    origin,
    report({ phase, upstreamStatus, elapsedMs, error }) {
      if (reported) return;
      reported = true;
      console.info(
        '[native-web-module-failure]',
        JSON.stringify({
          origin,
          phase,
          status: 502,
          upstreamStatus,
          elapsedMs: Math.round(elapsedMs),
          error: transportError(error),
          processes: processes.map(({ pid, startTime, kind, name }) => {
            const observed = inspectNativeProcess(pid);
            return {
              pid,
              startTime,
              role: kind === 'root' ? 'launcher' : name === 'workerd' ? 'workerd' : 'vite-node',
              identity: observed ? (observed.startTime === startTime ? 'same' : 'replaced') : 'unavailable',
            };
          }),
        }),
      );
    },
  };
}
