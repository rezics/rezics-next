import { Database } from 'bun:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importTransportCause, type ImportTransportError } from './import-client.ts';

/** Safe remaining seed request: method, path, source tuple and native type. No bodies or credentials. */
export type SeedRemainingRequest = {
  method: string;
  path: string;
  op?: string;
  source?: string;
  externalId?: string;
  nativeType?: string;
  converter?: string;
  journalState?: string;
  status?: number;
  type?: string;
  code?: string;
  phase?: string;
};

const SOURCE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const EXTERNAL_ID = /^[\x20-\x7e]{1,255}$/;
const CONVERTER = /^[\x20-\x7e]{1,64}$/;
const NATIVE_TYPE = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;
const OP = /^(create|propose|retract)$/;
const PATH = /^\/v1\/[A-Za-z0-9/_:-]{1,200}$/;

function admit(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

export function remainingRequestFromTransport(error: ImportTransportError): SeedRemainingRequest {
  return {
    method: error.method && /^(GET|POST|PUT|DELETE)$/.test(error.method) ? error.method : 'POST',
    path: admit(error.path, PATH) ?? '/v1/subjects:batchWrite',
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.type ? { type: error.type } : {}),
    ...(error.code ? { code: error.code } : {}),
    ...(error.phase ? { phase: error.phase } : {}),
  };
}

export function remainingRequestFromPreparedCommand(command: {
  op: string;
  source: { source: string; external_id: string; converter_revision: string };
  subject: string | { type?: string };
}): SeedRemainingRequest {
  const nativeType = admit(typeof command.subject === 'object' ? command.subject.type : undefined, NATIVE_TYPE);
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
  return {
    method: transport?.method ?? journal?.method ?? 'POST',
    path: transport?.path ?? journal?.path ?? '/v1/subjects:batchWrite',
    ...(journal?.op ? { op: journal.op } : {}),
    ...(journal?.source ? { source: journal.source } : {}),
    ...(journal?.externalId ? { externalId: journal.externalId } : {}),
    ...(journal?.nativeType ? { nativeType: journal.nativeType } : {}),
    ...(journal?.converter ? { converter: journal.converter } : {}),
    ...(journal?.journalState ? { journalState: journal.journalState } : {}),
    ...(transport?.status !== undefined ? { status: transport.status } : {}),
    ...(transport?.type ? { type: transport.type } : {}),
    ...(transport?.code ? { code: transport.code } : {}),
    ...(transport?.phase ? { phase: transport.phase } : {}),
  };
}

export function formatSeedRemainingRequest(remaining: SeedRemainingRequest): string {
  return [
    remaining.method,
    remaining.path,
    remaining.status,
    remaining.type,
    remaining.code,
    remaining.phase,
    remaining.op,
    remaining.source,
    remaining.externalId,
    remaining.nativeType,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join(' ')
    .slice(0, 240);
}

export function formatSeedFailure(error: unknown, remaining?: SeedRemainingRequest): string {
  const cause = error === undefined ? '' : importTransportCause(error);
  if (!remaining) return cause;
  const request =
    remaining.path && !cause.includes(remaining.path) ? `${remaining.method} ${remaining.path}` : undefined;
  const tuple = [remaining.op, remaining.source, remaining.externalId, remaining.nativeType]
    .filter((part) => part)
    .join(' ');
  return [cause, request, tuple && !cause.includes(tuple) ? tuple : undefined]
    .filter((part) => part)
    .join(' ')
    .slice(0, 240);
}

export async function writeSeedRemainingRequest(directory: string, remaining: SeedRemainingRequest): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'remaining-request.json');
  await writeFile(path, `${JSON.stringify(remaining)}\n`, { mode: 0o600 });
  return path;
}

export async function readSeedRemainingRequest(directory: string): Promise<SeedRemainingRequest | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, 'remaining-request.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.method !== 'string' || typeof record.path !== 'string') return undefined;
    const method = /^(GET|POST|PUT|DELETE)$/.test(record.method) ? record.method : 'POST';
    const path = admit(record.path, PATH) ?? '/v1/subjects:batchWrite';
    const op = admit(record.op, OP);
    const source = admit(record.source, SOURCE_ID);
    const externalId = admit(record.externalId, EXTERNAL_ID);
    const nativeType = admit(record.nativeType, NATIVE_TYPE);
    const converter = admit(record.converter, CONVERTER);
    return mergeRemainingRequest(
      {
        method,
        path,
        ...(op !== undefined ? { op } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(externalId !== undefined ? { externalId } : {}),
        ...(nativeType !== undefined ? { nativeType } : {}),
        ...(converter !== undefined ? { converter } : {}),
        ...(record.journalState === 'prepared' ? { journalState: 'prepared' } : {}),
      },
      {
        method,
        path,
        ...(typeof record.status === 'number' ? { status: record.status } : {}),
        ...(typeof record.type === 'string' ? { type: record.type } : {}),
        ...(typeof record.code === 'string' ? { code: record.code } : {}),
        ...(typeof record.phase === 'string' ? { phase: record.phase } : {}),
      },
    );
  } catch {
    return undefined;
  }
}
