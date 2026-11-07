import type { BatchWriteResult } from '@rezics/definitions/bulk';
import { formatImportTransportError, ImportTransportError } from './import-client.ts';
import type { ImportRequestDiagnostics } from './import-fetch.ts';

export type ReviewedCatalogueCommandKind = 'bootstrap' | 'proposal';

const PROBLEM_CODE = /^[a-z0-9_-]{1,80}$/;
const PROBLEM_TYPE = /^https:\/\/rezics\.com\/problems\/[a-z0-9_-]{1,80}$/;
const CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION = /^(subject:create|statement:propose)$/;
const TRANSACTION_PHASE =
  /^(?:before_command|command_overhead|time_mint|access_prepare|gate_wait|transaction_pool_wait|transaction_body|commit|writable_wait|contention_pause|request_completion)$/;
const SEED_KEY = /^[A-Za-z0-9._:-]{1,80}$/;

export type ReviewedCatalogueProblem = Readonly<{
  status?: number;
  type?: string;
  code?: string;
  retryable?: boolean;
  request_id?: string;
  operation?: 'subject:create' | 'statement:propose';
  partition?: number;
  phase?: string;
  contention_retries?: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicString(value: unknown, pattern: RegExp, limit: number): string | undefined {
  return typeof value === 'string' && value.length <= limit && pattern.test(value) ? value : undefined;
}

function publicStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

function publicPartition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}

function publicRetries(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : undefined;
}

/** Copy only public RFC9457 classifiers. Detail, errors, bodies and titles stay off the envelope. */
export function reviewedCatalogueProblem(value: unknown): ReviewedCatalogueProblem {
  if (!isRecord(value)) return {};
  const status = publicStatus(value.status);
  const type = publicString(value.type, PROBLEM_TYPE, 128);
  const code = publicString(value.code, PROBLEM_CODE, 80);
  const request_id = publicString(value.request_id, CORRELATION, 128);
  const operation = publicString(value.operation, OPERATION, 32) as ReviewedCatalogueProblem['operation'] | undefined;
  const partition = publicPartition(value.partition);
  const phase = publicString(value.phase, TRANSACTION_PHASE, 32);
  const contention_retries = publicRetries(value.contention_retries);
  return {
    ...(status === undefined ? {} : { status }),
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
    ...(value.retryable === true ? { retryable: true } : value.retryable === false ? { retryable: false } : {}),
    ...(request_id === undefined ? {} : { request_id }),
    ...(operation === undefined ? {} : { operation }),
    ...(partition === undefined ? {} : { partition }),
    ...(phase === undefined ? {} : { phase }),
    ...(contention_retries === undefined ? {} : { contention_retries }),
  };
}

export class ReviewedCatalogueCommandError extends ImportTransportError {
  readonly seedKey: string;
  readonly commandKind: ReviewedCatalogueCommandKind;
  readonly operationName: string | undefined;
  readonly partition: number | undefined;
  readonly transactionPhase: string | undefined;
  readonly contentionRetries: number | undefined;

  constructor(
    seedKey: string,
    commandKind: ReviewedCatalogueCommandKind,
    problem: ReviewedCatalogueProblem,
    diagnostics: Partial<ImportRequestDiagnostics> = {},
  ) {
    const status = problem.status;
    super(status, problem.type, problem.code, problem.retryable === true, undefined, undefined, {
      method: diagnostics.method ?? 'POST',
      ...(diagnostics.origin === undefined ? {} : { origin: diagnostics.origin }),
      path: diagnostics.path ?? '/v1/subjects:batchWrite',
      phase: diagnostics.phase ?? 'http',
      ...(status === undefined ? {} : { status }),
      ...(problem.code === undefined ? {} : { code: problem.code }),
      ...(problem.request_id === undefined ? {} : { correlationId: problem.request_id }),
    });
    this.name = 'ReviewedCatalogueCommandError';
    this.seedKey = seedKey;
    this.commandKind = commandKind;
    this.operationName = problem.operation;
    this.partition = problem.partition;
    this.transactionPhase = problem.phase;
    this.contentionRetries = problem.contention_retries;
  }
}

export function formatReviewedCatalogueCommandError(error: ReviewedCatalogueCommandError): string {
  const seed = publicString(error.seedKey, SEED_KEY, 80) ?? 'none';
  const operation = publicString(error.operationName, OPERATION, 32) ?? 'none';
  const partition =
    error.partition === undefined ? 'none' : Number.isSafeInteger(error.partition) ? String(error.partition) : 'none';
  const phase = publicString(error.transactionPhase, TRANSACTION_PHASE, 32) ?? 'none';
  return `${formatImportTransportError(error)} seed=${seed} kind=${error.commandKind} operation=${operation} partition=${partition} transaction_phase=${phase}`;
}

export function throwReviewedCatalogueBatchFailure(
  seedKey: string,
  kind: ReviewedCatalogueCommandKind,
  result: BatchWriteResult,
): void {
  const entry = result.results[0];
  if (!entry) throw new TypeError('Reviewed catalogue batch returned no command result');
  if ('problem' in entry)
    throw new ReviewedCatalogueCommandError(seedKey, kind, reviewedCatalogueProblem(entry.problem));
}

export function formatReviewedCatalogueSeedError(error: unknown): string {
  if (error instanceof ReviewedCatalogueCommandError) return formatReviewedCatalogueCommandError(error);
  if (error instanceof ImportTransportError) return formatImportTransportError(error);
  return 'Reviewed vocabulary seeding failed.';
}
