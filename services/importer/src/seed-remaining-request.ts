import { Database } from 'bun:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImportTransportError } from './import-client.ts';
import { formatSeedError, seedTransportError } from './seed-cli.ts';

/** Safe remaining seed request: method, path, source tuple and native type. No bodies or credentials. */
export type SeedRemainingRequest = {
  method: string;
  path: string;
  origin?: string;
  op?: string;
  source?: string;
  externalId?: string;
  nativeType?: string;
  converter?: string;
  journalState?: string;
  status?: number;
  type?: string;
  code?: string;
  retryable?: boolean;
  /** Existing caller classification, separate from the actual request failure phase. */
  phase?: string;
  failurePhase?: string;
  networkCode?: string;
  correlationId?: string;
};

const SOURCE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const EXTERNAL_ID = /^[\x20-\x7e]{1,255}$/;
const CONVERTER = /^[\x20-\x7e]{1,64}$/;
const NATIVE_TYPE = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;
const OP = /^(create|propose|retract)$/;
const METHOD = /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/;
const PATH = /^\/v1\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{1,507}$/;
const remainingFields = {
  origin: /^https?:\/\/[A-Za-z0-9.:[\]_-]{1,248}$/,
  op: OP,
  source: SOURCE_ID,
  externalId: EXTERNAL_ID,
  nativeType: NATIVE_TYPE,
  converter: CONVERTER,
  journalState: /^prepared$/,
  type: /^(?:about:blank|https:\/\/rezics\.com\/problems\/[a-z0-9_-]{1,80})$/,
  code: /^[a-z0-9_-]{1,80}$/,
  phase: /^(readiness|merge403|SubjectGET503)$/,
  failurePhase: /^(network|token|deadline|http|response|integrity)$/,
  networkCode: /^(?:E[A-Z0-9_]{1,64}|ERR_[A-Z0-9_]{1,64}|UND_ERR_[A-Z0-9_]{1,64})$/,
  correlationId: /^[A-Za-z0-9._:-]{1,128}$/,
} as const;

function admit(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value ? value : undefined;
}

/** One allowlist for in-memory diagnostics and private artifact reads/writes; never serialize a cause or body. */
function safeRemainingRequest(value: Partial<SeedRemainingRequest>): SeedRemainingRequest {
  const remaining: SeedRemainingRequest = {
    method: admit(value.method, METHOD) ?? 'unknown',
    path: admit(value.path, PATH) ?? 'unknown',
  };
  for (const key of Object.keys(remainingFields) as (keyof typeof remainingFields)[]) {
    const field = admit(value[key], remainingFields[key]);
    if (field !== undefined) remaining[key] = field;
  }
  if (Number.isInteger(value.status) && value.status! >= 100 && value.status! <= 599) remaining.status = value.status!;
  if (typeof value.retryable === 'boolean') remaining.retryable = value.retryable;
  return remaining;
}

export function remainingRequestFromTransport(error: ImportTransportError): SeedRemainingRequest {
  return safeRemainingRequest({
    method: error.method ?? 'unknown',
    path: error.path ?? 'unknown',
    ...(error.origin !== undefined ? { origin: error.origin } : {}),
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.type ? { type: error.type } : {}),
    ...(error.code ? { code: error.code } : {}),
    ...(error.phase ? { phase: error.phase } : {}),
    retryable: error.retryable,
    ...(error.failurePhase ? { failurePhase: error.failurePhase } : {}),
    ...(error.networkCode ? { networkCode: error.networkCode } : {}),
    ...(error.correlationId ? { correlationId: error.correlationId } : {}),
  });
}

export function remainingRequestFromPreparedCommand(command: {
  op: string;
  source: { source: string; external_id: string; converter_revision: string };
  subject: string | { type?: string };
}): SeedRemainingRequest {
  const nativeType = admit(
    command.subject && typeof command.subject === 'object' ? command.subject.type : undefined,
    NATIVE_TYPE,
  );
  const op = admit(command.op, OP);
  const source = admit(command.source.source, SOURCE_ID);
  const externalId = admit(command.source.external_id, EXTERNAL_ID);
  const converter = admit(command.source.converter_revision, CONVERTER);
  return {
    method: 'POST',
    path: '/v1/subjects:batchWrite',
    ...(op !== undefined ? { op } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(externalId !== undefined ? { externalId } : {}),
    ...(nativeType !== undefined ? { nativeType } : {}),
    ...(converter !== undefined ? { converter } : {}),
    journalState: 'prepared',
  };
}

export function remainingRequestFromPreparedJournal(path: string): SeedRemainingRequest | undefined {
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true, strict: true });
    const row = database
      .query<{ command_json: string }, []>(
        "SELECT command_json FROM showcase_command WHERE state='prepared' ORDER BY command_key LIMIT 1",
      )
      .get();
    if (!row) return undefined;
    const command: unknown = JSON.parse(row.command_json);
    if (
      !command ||
      typeof command !== 'object' ||
      !('op' in command) ||
      !('source' in command) ||
      !command.source ||
      typeof command.source !== 'object'
    )
      return undefined;
    const source = command.source as { source?: unknown; external_id?: unknown; converter_revision?: unknown };
    if (typeof command.op !== 'string' || typeof source.source !== 'string' || typeof source.external_id !== 'string')
      return undefined;
    return remainingRequestFromPreparedCommand({
      op: command.op,
      source: {
        source: source.source,
        external_id: source.external_id,
        converter_revision: typeof source.converter_revision === 'string' ? source.converter_revision : '',
      },
      subject: 'subject' in command ? (command.subject as string | { type?: string }) : '',
    });
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

export function mergeRemainingRequest(
  journal?: SeedRemainingRequest,
  transport?: SeedRemainingRequest,
): SeedRemainingRequest {
  return safeRemainingRequest({
    // A new failure replaces old diagnostics as a unit: a network failure must not inherit an old HTTP status.
    ...(transport ?? journal),
    method: admit(transport?.method, METHOD) ?? journal?.method ?? 'unknown',
    path: admit(transport?.path, PATH) ?? journal?.path ?? 'unknown',
    ...(journal?.op ? { op: journal.op } : {}),
    ...(journal?.source ? { source: journal.source } : {}),
    ...(journal?.externalId ? { externalId: journal.externalId } : {}),
    ...(journal?.nativeType ? { nativeType: journal.nativeType } : {}),
    ...(journal?.converter ? { converter: journal.converter } : {}),
    ...(journal?.journalState ? { journalState: journal.journalState } : {}),
  });
}

export function formatSeedRemainingRequest(remaining: SeedRemainingRequest): string {
  const safe = safeRemainingRequest(remaining);
  const tuple = [safe.op, safe.source, safe.externalId, safe.nativeType]
    .map((part) => (part === undefined ? 'unknown' : /\s|["\\]/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
  let line = `status=${safe.status ?? 'none'} type=${safe.type ?? 'none'} problem=${safe.code ?? 'none'} phase=${safe.failurePhase ?? 'unknown'} pending=${tuple}`;
  // Required fields have their own admission bounds and are never sliced. Spend the remaining 240-character
  // budget on whole optional fields, so a long target cannot erase either the cause or the pending identity.
  const optional = [
    safe.phase && `classification=${safe.phase}`,
    safe.networkCode && `network=${safe.networkCode}`,
    safe.correlationId && `correlation=${safe.correlationId}`,
    safe.retryable !== undefined && `retryable=${safe.retryable}`,
    `method=${safe.method}`,
    `target=${safe.origin ?? ''}${safe.path}`,
    safe.converter && `converter=${JSON.stringify(safe.converter)}`,
    safe.journalState && `journal=${safe.journalState}`,
  ];
  for (const field of optional) if (field && line.length + field.length + 1 <= 240) line += ` ${field}`;
  return line;
}

export function formatSeedFailure(error: unknown, remaining?: SeedRemainingRequest): string {
  const transport = seedTransportError(error);
  if (transport)
    return formatSeedRemainingRequest(mergeRemainingRequest(remaining, remainingRequestFromTransport(transport)));
  const cause = error === undefined ? '' : formatSeedError(error);
  if (!remaining) return cause;
  const line = formatSeedRemainingRequest(remaining);
  return cause && line.length + cause.length + 1 <= 240 ? `${line} ${cause}` : line;
}

export async function writeSeedRemainingRequest(directory: string, remaining: SeedRemainingRequest): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'remaining-request.json');
  await writeFile(path, `${JSON.stringify(safeRemainingRequest(remaining))}\n`, { mode: 0o600 });
  return path;
}

export async function readSeedRemainingRequest(directory: string): Promise<SeedRemainingRequest | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, 'remaining-request.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.method !== 'string' || typeof record.path !== 'string') return undefined;
    return safeRemainingRequest(record as Partial<SeedRemainingRequest>);
  } catch {
    return undefined;
  }
}
