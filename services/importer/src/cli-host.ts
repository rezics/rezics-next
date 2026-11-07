import { createAccountTokenProvider } from './credentials.ts';
import { type ImportCliClock, type ImportCliOptions, type ImportCliResult } from './cli-contract.ts';
import { createImporter } from './importer.ts';
import { createImportTransport } from './import-client.ts';
import { createWritableProgressSink } from './import-progress.ts';
import { readImportProcessIdentity, type ImportProcessIdentity } from './import-session.ts';

const defaultClock: ImportCliClock = {
  now: () => Date.now(),
  sleep: async (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export type ImportCliHost = {
  /** Original caller bindings for this attempt; nested jobs inherit these. */
  invocation: ImportCliOptions;
  clock: ImportCliClock;
  /** True only when the caller supplied a clock; Importer then uses that wait instead of its native timer. */
  explicitClock: boolean;
  fetch: typeof fetch;
  createImporter: typeof createImporter;
  createTransport: typeof createImportTransport;
  createTokenProvider: typeof createAccountTokenProvider;
  processIdentity: ImportProcessIdentity;
  /** Lives for the whole CLI attempt, including nested single-source runs. */
  attempt: AbortController;
  mergeInvocation(overrides?: ImportCliOptions): ImportCliOptions;
};

function assignedFetch(fetchImpl: typeof fetch | undefined): typeof fetch {
  return fetchImpl ?? globalThis.fetch;
}

/** Bind process, SQLite-adjacent factories, network and clock once for an Import CLI attempt. */
export function createImportCliHost(invocation: ImportCliOptions = {}): ImportCliHost {
  const attempt = new AbortController();
  const clock = invocation.clock ?? defaultClock;
  const fetchImpl = assignedFetch(invocation.fetch);
  const create = invocation.createImporter ?? createImporter;
  const processIdentity = readImportProcessIdentity();
  return {
    invocation,
    clock,
    explicitClock: invocation.clock !== undefined,
    fetch: fetchImpl,
    createImporter: create,
    createTransport: createImportTransport,
    createTokenProvider: createAccountTokenProvider,
    processIdentity,
    attempt,
    mergeInvocation(overrides = {}) {
      const stdin = overrides.stdin ?? invocation.stdin;
      const entries = overrides.entries ?? invocation.entries;
      const signal = overrides.signal ?? invocation.signal;
      const testOrigin = overrides.testOrigin ?? invocation.testOrigin;
      const instrumentDatabase = overrides.instrumentDatabase ?? invocation.instrumentDatabase;
      const observer = overrides.observer ?? invocation.observer;
      const progressSink = overrides.progressSink ?? invocation.progressSink;
      const progressTty = overrides.progressTty ?? invocation.progressTty;
      return {
        fetch: overrides.fetch ?? fetchImpl,
        clock: overrides.clock ?? clock,
        createImporter: overrides.createImporter ?? create,
        ...(stdin === undefined ? {} : { stdin }),
        ...(entries === undefined ? {} : { entries }),
        ...(signal === undefined ? {} : { signal }),
        ...(testOrigin === undefined ? {} : { testOrigin }),
        ...(instrumentDatabase === undefined ? {} : { instrumentDatabase }),
        ...(observer === undefined ? {} : { observer }),
        ...(progressSink === undefined ? {} : { progressSink }),
        ...(progressTty === undefined ? {} : { progressTty }),
      };
    },
  };
}

/** Actual process entry: stderr progress, stdin, interrupt signal and attempt lifetime. */
export function bindImportCliProcess(signal: AbortSignal): ImportCliHost {
  return createImportCliHost({
    stdin: process.stdin as AsyncIterable<Uint8Array>,
    signal,
    progressSink: createWritableProgressSink(process.stderr),
    progressTty: process.stderr.isTTY === true,
  });
}

export async function writeImportCliProcessResult(result: ImportCliResult): Promise<void> {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
