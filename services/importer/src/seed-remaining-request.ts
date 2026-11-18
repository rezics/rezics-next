import { Database } from 'bun:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BATCH_LIMIT,
  BATCH_CONSTRAINT_NAME,
  BATCH_SQLSTATE,
  BATCH_WRITE_FAILURE_STAGES,
  type BatchCommand,
  type BatchWriteFailureStage,
  type BatchWriteResult,
} from '@rezics/definitions/bulk';
import { reviewedCatalogueProblem } from './http.ts';
import type { ImportTransportError } from './import-client.ts';
import { formatSeedError, seedTransportError } from './seed-cli.ts';

const batchTransitions = [
  'graph-retain',
  'graph-prepare',
  'retraction-prepare',
  'batch-validate',
  'batch-send',
  'batch-receipt',
  'graph-acknowledge',
  'showcase-prepare',
  'showcase-acknowledge',
] as const;
type BatchTransition = (typeof batchTransitions)[number];
const batchReasons = [
  'local-failure',
  'invalid-envelope',
  'request-failed',
  'command-refused',
  'missing-receipt',
  'invalid-receipt',
] as const;
type BatchReason = (typeof batchReasons)[number];

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
  commandIndex?: number;
  transition?: BatchTransition;
  reason?: BatchReason;
  transactionPhase?: string;
  failureStage?: BatchWriteFailureStage;
  sqlstate?: string;
  constraintName?: string;
};

const BATCH_ROUTE = '/v1/subjects:batchWrite';
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
  transition: new RegExp(`^(?:${batchTransitions.join('|')})$`),
  reason: new RegExp(`^(?:${batchReasons.join('|')})$`),
  transactionPhase: /^[a-z_]{1,32}$/,
  failureStage: new RegExp(`^(?:${BATCH_WRITE_FAILURE_STAGES.join('|')})$`),
  sqlstate: BATCH_SQLSTATE,
  constraintName: BATCH_CONSTRAINT_NAME,
} as const;

function admit(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value ? value : undefined;
}

/** One allowlist for in-memory diagnostics and private artifact reads/writes; never serialize a cause or body. */
function safeRemainingRequest(value: {
  [Key in keyof SeedRemainingRequest]?: SeedRemainingRequest[Key] | undefined;
}): SeedRemainingRequest {
  const remaining: SeedRemainingRequest = {
    method: admit(value.method, METHOD) ?? 'unknown',
    path: admit(value.path, PATH) ?? 'unknown',
  };
  for (const key of Object.keys(remainingFields) as (keyof typeof remainingFields)[]) {
    const field = admit(value[key], remainingFields[key]);
    if (field !== undefined) Object.assign(remaining, { [key]: field });
  }
  if (Number.isInteger(value.status) && value.status! >= 100 && value.status! <= 599) remaining.status = value.status!;
  const index = value.commandIndex;
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < BATCH_LIMIT)
    remaining.commandIndex = index;
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

type CommandIdentity = {
  op: string;
  source: { source: string; external_id: string; converter_revision: string };
  subject: string | { type?: string };
};

function commandRequest(command?: CommandIdentity): SeedRemainingRequest {
  return safeRemainingRequest({
    method: 'POST',
    path: BATCH_ROUTE,
    op: command?.op,
    source: command?.source.source,
    externalId: command?.source.external_id,
    nativeType: command?.subject && typeof command.subject === 'object' ? command.subject.type : undefined,
    converter: command?.source.converter_revision,
  });
}

export function remainingRequestFromPreparedCommand(command: CommandIdentity): SeedRemainingRequest {
  return { ...commandRequest(command), journalState: 'prepared' };
}

const batchFailures = new WeakMap<Error, SeedRemainingRequest>();

/** Keep request-local failure metadata, including the exact command only when its identity is known. */
export function recordSeedBatchFailure(
  error: unknown,
  transition: BatchTransition,
  reason: BatchReason,
  command?: BatchCommand,
  receipt?: BatchWriteResult['results'][number],
): Error {
  const failure = error instanceof Error ? error : new Error('Seed batch delivery failed', { cause: error });
  if (batchFailures.has(failure)) return failure;
  const transport = seedTransportError(failure);
  const remote = receipt && 'problem' in receipt ? receipt.problem : undefined;
  const problem = reviewedCatalogueProblem(remote);
  const request = commandRequest(command);
  const failurePhase = receipt
    ? 'response'
    : (transport?.failurePhase ??
      (failure instanceof DOMException && failure.name === 'TimeoutError' ? 'deadline' : undefined));
  batchFailures.set(
    failure,
    safeRemainingRequest({
      ...mergeRemainingRequest(request, transport && remainingRequestFromTransport(transport)),
      transition,
      reason,
      ...(receipt === undefined ? {} : { status: receipt.status }),
      failurePhase,
      type: problem.type ?? (remote?.type === 'about:blank' ? 'about:blank' : transport?.type),
      code: problem.code ?? transport?.code,
      retryable: problem.retryable ?? transport?.retryable,
      correlationId: problem.request_id ?? transport?.correlationId,
      transactionPhase: problem.phase,
      ...((command?.op === 'create' || command?.op === 'propose') &&
      receipt?.status === 500 &&
      problem.code === 'internal_error'
        ? {
            commandIndex: problem.command_index,
            failureStage: problem.failure_stage,
            ...(command.op === 'propose'
              ? { sqlstate: problem.sqlstate, constraintName: problem.constraint_name }
              : {}),
          }
        : {}),
    }),
  );
  return failure;
}

export function seedBatchRemainingRequest(error: unknown): SeedRemainingRequest | undefined {
  return error instanceof Error ? batchFailures.get(error) : undefined;
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
  const transition = safe.transition ? ` transition=${safe.transition} reason=${safe.reason ?? 'unknown'}` : '';
  const type = safe.transition ? '' : ` type=${safe.type ?? 'none'}`;
  let line = `status=${safe.status ?? 'none'}${type} problem=${safe.code ?? 'none'} phase=${safe.failurePhase ?? 'unknown'}${transition} pending=${tuple}`;
  // Required fields have their own admission bounds and are never sliced. Spend the remaining 240-character
  // budget on whole optional fields, so a long target cannot erase either the cause or the pending identity.
  const optional = [
    safe.failureStage && `stage=${safe.failureStage}`,
    safe.sqlstate && `sqlstate=${safe.sqlstate}`,
    safe.constraintName && `constraint=${safe.constraintName}`,
    safe.transactionPhase && `transaction_phase=${safe.transactionPhase}`,
    safe.phase && `classification=${safe.phase}`,
    safe.networkCode && `network=${safe.networkCode}`,
    safe.correlationId && `correlation=${safe.correlationId}`,
    safe.retryable !== undefined && `retryable=${safe.retryable}`,
    `method=${safe.method}`,
    `target=${safe.origin ?? ''}${safe.path}`,
    safe.converter && `converter=${JSON.stringify(safe.converter)}`,
    safe.journalState && `journal=${safe.journalState}`,
    safe.transition && safe.type && `type=${safe.type}`,
  ];
  for (const field of optional) if (field && line.length + field.length + 1 <= 240) line += ` ${field}`;
  return line;
}

export function formatSeedFailure(error: unknown, remaining?: SeedRemainingRequest): string {
  const batch = seedBatchRemainingRequest(error) ?? (remaining?.transition ? remaining : undefined);
  if (batch) return formatSeedRemainingRequest(batch);
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
