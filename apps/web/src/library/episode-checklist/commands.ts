import { recordBody, type EpisodeRecordResult } from './native';
import { mutationIntent, type ChecklistCommand, type ChecklistIntent, type ChecklistOutcome } from './contract';

export type EpisodeSender = (input: {
  sessionId: string;
  credential: HeadersInit;
  key: string;
  revision: number;
  intent: ChecklistIntent;
}) => Promise<EpisodeRecordResult>;

export function headersRecord(headers: HeadersInit): Record<string, string> {
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return headers as Record<string, string>;
}

export function captureEpisodeCommand(
  credential: HeadersInit,
  sessionId: string,
  revision: number,
  key: string,
  intent: ChecklistIntent,
): ChecklistCommand {
  return {
    sender: 'recordCanonicalEpisodes',
    credential: headersRecord(credential),
    key,
    operands: { sessionId, revision, body: recordBody(revision, intent) },
  };
}

export type BoundEpisodeCommand = ChecklistCommand & { dispatch: EpisodeSender };

export function bindEpisodeCommand(command: ChecklistCommand, sender: EpisodeSender): BoundEpisodeCommand {
  return { ...command, dispatch: sender };
}

export function intentOf(command: ChecklistCommand): ChecklistIntent {
  const body = command.operands.body;
  if ('clear' in body && body.clear === true) return { kind: 'clear' };
  return {
    kind: 'patch',
    add: 'add' in body ? (body.add ?? []) : [],
    remove: 'remove' in body ? (body.remove ?? []) : [],
  };
}

export function outcomeFromRecord(command: ChecklistCommand, result: EpisodeRecordResult): ChecklistOutcome {
  if (result.ok) return { state: 'acknowledged', revision: result.revision };
  if (result.kind === 'conflict') return { state: 'conflict', command, revision: command.operands.revision };
  if (result.kind === 'stale_cursor') return { state: 'stale_cursor', command };
  if (result.kind === 'idempotency_conflict') return { state: 'ambiguous', command };
  if (result.kind === 'unsupported_library_profile') return { state: 'unsupported', command };
  if (result.kind === 'not_found') return { state: 'retired', command };
  if (result.kind === 'denied') return { state: 'refused', command };
  if (result.kind === 'invalid_request' || result.kind === 'invalid_cursor') {
    return { state: 'invalid', command, kind: result.kind };
  }
  return {
    state: 'unavailable',
    command,
    seam: result.seam ?? 'KernelClient.progressSessions({ sessionId }).$recordEpisodes.post',
  };
}

export function uncertainOutcome(command: ChecklistCommand): ChecklistOutcome {
  return { state: 'uncertain', command };
}

export async function dispatchEpisodeCommand(
  command: BoundEpisodeCommand,
  current: () => boolean,
): Promise<EpisodeRecordResult | undefined> {
  const intent = intentOf(command);
  const result = await command.dispatch({
    sessionId: command.operands.sessionId,
    credential: command.credential,
    key: command.key,
    revision: command.operands.revision,
    intent,
  });
  return current() ? result : undefined;
}

export async function submitEpisodeIntent(
  sessionId: string,
  revision: number,
  intent: ChecklistIntent,
  credential: HeadersInit,
  current: () => boolean,
  sender: EpisodeSender,
  key: string,
  captured?: BoundEpisodeCommand,
): Promise<{ outcome: ChecklistOutcome; command: BoundEpisodeCommand }> {
  const command =
    captured ?? bindEpisodeCommand(captureEpisodeCommand(credential, sessionId, revision, key, intent), sender);
  if (!current()) return { outcome: uncertainOutcome(command), command };
  if (command.operands.revision !== revision) {
    return { outcome: { state: 'conflict', command, revision }, command };
  }
  let result: EpisodeRecordResult | undefined;
  try {
    result = await dispatchEpisodeCommand(command, current);
  } catch {
    return { outcome: uncertainOutcome(command), command };
  }
  if (!result) return { outcome: uncertainOutcome(command), command };
  return { outcome: outcomeFromRecord(command, result), command };
}

export function retryOriginal(command: BoundEpisodeCommand, current: () => boolean) {
  return dispatchEpisodeCommand(command, current);
}

export function intentFromSelection(add: readonly string[], remove: readonly string[]): ChecklistIntent | null {
  return mutationIntent(add, remove);
}
