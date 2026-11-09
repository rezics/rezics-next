import { CredentialDeniedError, CredentialServiceError } from './credentials.ts';
import { formatImportTransportError, ImportTransportError } from './import-client.ts';
import { importRequestFailure, type ImportRequestDiagnostics } from './import-fetch.ts';
import type { ImportRunResult } from './importer.ts';

/** Fixed local phases only: never derive diagnostic text from source records or remote errors. */
const finalizationPhases = {
  seed: [
    'vocabulary-preparation',
    'record-import',
    'release-publication',
    'tag-publication',
    'credit-vocabulary',
    'character-profile-vocabulary',
    'character-role-vocabulary',
    'bangumi-character-vocabulary',
    'creator-current-reads',
    'character-traits',
    'books',
    'showcase-publication',
    'person-merge',
    'person-current-reads',
    'character-current-reads',
    'credit-current-reads',
    'persona',
    'result-write',
  ],
  publication: [
    'cover-current-reads',
    'target-current-reads',
    'candidate-recovery',
    'candidate-current-reads',
    'manifest-validation',
    'acceptance',
    'tag-parent-publication',
    'membership-acceptance',
    'adoption',
    'public-readback',
    'manifest-finalization',
  ],
  books: ['planning', 'record-import', 'credit-vocabulary', 'creator-current-reads', 'result'],
} as const;

type FinalizationScope = keyof typeof finalizationPhases;
type FinalizationDiagnostic = { scope: FinalizationScope; phase: string; remaining: readonly string[] };
const finalizationFailures = new WeakMap<object, readonly FinalizationDiagnostic[]>();
const importRunFailures = new WeakMap<object, { provider: 'bangumi' | 'vndb'; kind: ImportRunResult['status'] }>();

/** Register only the local run classification; its diagnostic may contain private source or response text. */
export function seedImportRunFailure(provider: 'bangumi' | 'vndb', result: ImportRunResult): Error {
  const error = new TypeError(`Cross-media ${provider} import failed: ${result.status} (${result.diagnostic})`);
  importRunFailures.set(error, { provider, kind: result.status });
  return error;
}

function finalizationDetail(value: FinalizationDiagnostic): string {
  return `scope=${value.scope} phase=${value.phase} remaining=${value.remaining.join(',') || 'none'}`;
}

/** One line per phase transition, with no polling, per-record output or new replay state. */
export class SeedFinalization<Scope extends FinalizationScope> {
  readonly #scope: Scope;
  readonly #write: (line: string) => void;
  #current: FinalizationDiagnostic;

  constructor(
    scope: Scope,
    write: (line: string) => void = (line) => {
      process.stderr.write(line + '\n');
    },
  ) {
    this.#scope = scope;
    this.#write = write;
    this.#current = { scope, phase: finalizationPhases[scope][0], remaining: finalizationPhases[scope] };
  }

  enter(phase: (typeof finalizationPhases)[Scope][number]): void {
    const phases: readonly string[] = finalizationPhases[this.#scope];
    this.#current = { scope: this.#scope, phase, remaining: phases.slice(phases.indexOf(phase)) };
    this.#write(`Cross-media seed finalization state=started ${finalizationDetail(this.#current)}`);
  }

  complete(): void {
    this.#write(`Cross-media seed finalization state=completed scope=${this.#scope} remaining=none`);
  }

  failed(error: unknown): void {
    this.#write(`Cross-media seed finalization state=failed ${finalizationDetail(this.#current)}`);
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
      const previous = finalizationFailures.get(error) ?? [];
      finalizationFailures.set(error, [...previous.filter((value) => value.scope !== this.#scope), this.#current]);
    }
  }
}

type CredentialFailure = CredentialDeniedError | CredentialServiceError;

function safeField(value: unknown, pattern: RegExp, limit: number): string | undefined {
  return typeof value === 'string' && value.length <= limit && pattern.test(value) ? value : undefined;
}

function details(values: Partial<ImportRequestDiagnostics>, fallbackPhase: string): string {
  const operation =
    values.operation === 'dump-download' || values.operation === 'dump-index' ? `operation=${values.operation} ` : '';
  const method = safeField(values.method, /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/u, 8) ?? 'unknown';
  const origin = safeField(values.origin, /^https?:\/\/[A-Za-z0-9.:[\]_-]+(?::[0-9]{1,5})?$/u, 256);
  const path = safeField(values.path, /^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{0,512}$/u, 512);
  const target = `${origin ?? 'unknown-origin'}${path ?? ''}`;
  const phase = safeField(values.phase, /^[a-z-]{1,24}$/u, 24) ?? fallbackPhase;
  const status =
    Number.isInteger(values.status) && values.status! >= 100 && values.status! <= 599 ? String(values.status) : 'none';
  const code = safeField(values.code, /^[a-z0-9_-]{1,80}$/u, 80) ?? 'none';
  const network =
    safeField(values.networkCode, /^(?:E[A-Z0-9_]{1,64}|ERR_[A-Z0-9_]{1,64}|UND_ERR_[A-Z0-9_]{1,64})$/u, 72) ?? 'none';
  const correlation = safeField(values.correlationId, /^[A-Za-z0-9._:-]{1,128}$/u, 128) ?? 'none';
  return `${operation}phase=${phase} method=${method} target=${target} status=${status} problem=${code} network=${network} correlation=${correlation}`;
}

function credentialCause(error: unknown): CredentialFailure | undefined {
  return error instanceof CredentialDeniedError || error instanceof CredentialServiceError ? error : undefined;
}

/** Render only safe operation metadata. Causes and response bodies remain private to the Error chain. */
export function formatSeedError(error: unknown): string {
  const phases =
    (typeof error === 'object' && error !== null) || typeof error === 'function'
      ? finalizationFailures.get(error)
      : undefined;
  return (
    formatSeedCause(error) + (phases?.map((phase) => ` finalization{${finalizationDetail(phase)}}`).join('') ?? '')
  );
}

function formatSeedCause(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const run = importRunFailures.get(error);
    if (run) return `Cross-media seed import failed provider=${run.provider} kind=${run.kind}`;
  }
  if (error instanceof ImportTransportError) {
    const cause = credentialCause(error.cause);
    return `${formatImportTransportError(error)}${cause ? ` auth{${details(cause.diagnostics ?? {}, 'credential')}}` : ''}`;
  }
  if (error instanceof CredentialDeniedError || error instanceof CredentialServiceError)
    return `Credential request failed ${details(error.diagnostics ?? {}, 'credential')}`;
  const diagnostics = importRequestFailure(error);
  if (diagnostics?.operation) return `Cross-media seed source failure ${details(diagnostics, 'source')}`;
  return 'Cross-media seed failed';
}
