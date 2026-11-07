import { CredentialDeniedError, CredentialServiceError } from './credentials.ts';
import { ImportTransportError } from './import-client.ts';
import type { ImportRequestDiagnostics } from './import-fetch.ts';

type CredentialFailure = CredentialDeniedError | CredentialServiceError;

function safeField(value: unknown, pattern: RegExp, limit: number): string | undefined {
  return typeof value === 'string' && value.length <= limit && pattern.test(value) ? value : undefined;
}

function details(values: Partial<ImportRequestDiagnostics>, fallbackPhase: string): string {
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
  return `phase=${phase} method=${method} target=${target} status=${status} problem=${code} network=${network} correlation=${correlation}`;
}

function credentialCause(error: unknown): CredentialFailure | undefined {
  return error instanceof CredentialDeniedError || error instanceof CredentialServiceError ? error : undefined;
}

/** Render only safe operation metadata. Causes and response bodies remain private to the Error chain. */
export function formatSeedError(error: unknown): string {
  if (error instanceof ImportTransportError) {
    const cause = credentialCause(error.cause);
    const outer = details(
      {
        ...(error.method === undefined ? {} : { method: error.method }),
        ...(error.origin === undefined ? {} : { origin: error.origin }),
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.failurePhase === undefined ? {} : { phase: error.failurePhase }),
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.networkCode === undefined ? {} : { networkCode: error.networkCode }),
        ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId }),
      },
      error.status === undefined ? 'transport' : 'http',
    );
    const classification = safeField(error.phase, /^[A-Za-z][A-Za-z0-9]{0,31}$/u, 32);
    return `Import transport failed ${outer}${classification ? ` classification=${classification}` : ''}${cause ? ` auth{${details(cause.diagnostics ?? {}, 'credential')}}` : ''}`;
  }
  if (error instanceof CredentialDeniedError || error instanceof CredentialServiceError)
    return `Credential request failed ${details(error.diagnostics ?? {}, 'credential')}`;
  if (error instanceof Error) {
    const name = safeField(error.name, /^[A-Za-z][A-Za-z0-9]{0,63}$/u, 64) ?? 'Error';
    return `Cross-media seed failed (${name})`;
  }
  return 'Cross-media seed failed';
}
