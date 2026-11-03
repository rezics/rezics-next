import type { CopyRemoveResult, CopyWriteResult } from '../copies-read';
import type { ProgressFailure, ProgressRecorded, ProgressRecordInput, ProgressStarted } from '../progress-reads';

export type GuardedSender<Input, Result> = (input: {
  data: Input;
  headers: HeadersInit;
}) => Promise<Result>;

/** Captured native command. Retry keeps this sender, credential, key and operands. */
export type GuardedCommand<Input, Result> = {
  sender: GuardedSender<Input, Result>;
  credential: string;
  key: string;
  operands: Input;
  running: boolean;
  response?: Result;
};

export type GuardedOutcome =
  | { state: 'acknowledged' }
  | { state: 'conflict' }
  | { state: 'unsupported' }
  | { state: 'unavailable' }
  | { state: 'refused' }
  | { state: 'invalid' };

export function createGuardedCommand<Input extends { idempotencyKey: string }, Result>(
  sender: GuardedSender<Input, Result>,
  credential: string,
  operands: Input,
): GuardedCommand<Input, Result> {
  return {
    sender,
    credential,
    key: operands.idempotencyKey,
    operands: { ...operands },
    running: false,
  };
}

function acknowledged(result: unknown): boolean {
  return !!result && typeof result === 'object' && 'ok' in result && (result as { ok: unknown }).ok === true;
}

export async function dispatchGuardedCommand<Input, Result>(
  command: GuardedCommand<Input, Result>,
  current: () => boolean,
): Promise<Result | undefined> {
  if (command.running) return command.response;
  if (command.response !== undefined && acknowledged(command.response)) {
    return current() ? command.response : undefined;
  }
  command.running = true;
  try {
    const result = await command.sender({
      data: command.operands,
      headers: { 'X-CSRF-Token': command.credential },
    });
    command.response = acknowledged(result) ? result : undefined;
    return current() ? result : undefined;
  } finally {
    command.running = false;
  }
}

export function copyWriteOutcome(result: CopyWriteResult | CopyRemoveResult): GuardedOutcome {
  if (result.ok) return { state: 'acknowledged' };
  if (result.reason === 'conflict') return { state: 'conflict' };
  if (result.reason === 'unsupported') return { state: 'unsupported' };
  if (result.reason === 'forbidden' || result.reason === 'closed') return { state: 'refused' };
  if (result.reason === 'invalid') return { state: 'invalid' };
  return { state: 'unavailable' };
}

export function progressWriteOutcome(result: ProgressStarted | ProgressRecorded | ProgressFailure): GuardedOutcome {
  if (result.ok) return { state: 'acknowledged' };
  if (result.reason === 'conflict') return { state: 'conflict' };
  if (result.reason === 'unsupported_library_profile') return { state: 'unsupported' };
  if (result.reason === 'forbidden' || result.reason === 'closed') return { state: 'refused' };
  if (result.reason === 'invalid') return { state: 'invalid' };
  return { state: 'unavailable' };
}

export type CopyCreateOperands = {
  subjectId: string;
  kind: string;
  status: string;
  location: string;
  source: string;
  acquiredOn: string;
  disposedOn: string;
  note: string;
  idempotencyKey: string;
};

export type CopyUpdateOperands = {
  id: string;
  revision: number;
  status?: string;
  location: string;
  source: string;
  acquiredOn: string;
  disposedOn: string;
  note: string;
  idempotencyKey: string;
};

export type ManualProgressStartOperands = {
  subjectId: string;
  mode: 'scalar_amount';
  unit: string;
  idempotencyKey: string;
};

export type ManualProgressRecordOperands = ProgressRecordInput;

export function sameGuardedCommand<Input>(
  command: GuardedCommand<Input, unknown>,
  sender: GuardedSender<Input, unknown>,
  credential: string,
  key: string,
  operands: Input,
): boolean {
  return (
    command.sender === sender &&
    command.credential === credential &&
    command.key === key &&
    command.operands === operands
  );
}
