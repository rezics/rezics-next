import type { Locale } from '../../paraglide/runtime.js';
import type { CheckpointCommand, CheckpointView, CheckpointWrite } from './checkpoint-api';
import { sameCheckpointPosition } from './checkpoint-position';
import type { CheckpointObservation } from './native-checkpoint';

export type CheckpointReadRequest = {
  data: { subjectId: string; viewer: string; locale: Locale };
  signal: AbortSignal;
};
export type CheckpointDispatch = {
  data: { command: CheckpointCommand; key: string; viewer: string; locale: Locale };
  headers: { 'X-CSRF-Token': string };
  signal: AbortSignal;
};
export type CheckpointTransport = {
  read: (request: CheckpointReadRequest) => Promise<CheckpointObservation>;
  write: (request: CheckpointDispatch) => Promise<CheckpointWrite>;
};

/** One effect incarnation, including Strict Mode's replacement setup, owns its requests. */
export type CheckpointLifetime = {
  controller: AbortController;
  current: () => boolean;
  read: object | null;
  write: object | null;
  intent: CheckpointIntent | null;
};

/** Only the original action's supplied label is retained, not a cached checkpoint observation. */
export type CheckpointIntentContext =
  | { kind: 'save'; title: string }
  | { kind: 'clear'; title: string | null };

export type CheckpointIntent = Readonly<{
  owner: CheckpointLifetime;
  request: CheckpointDispatch;
  sender: CheckpointTransport['write'];
  context: CheckpointIntentContext;
}>;

export function captureCheckpointIntent(input: {
  owner: CheckpointLifetime;
  command: CheckpointCommand;
  key: string;
  viewer: string;
  locale: Locale;
  csrfToken: string;
  sender: CheckpointTransport['write'];
  context: CheckpointIntentContext;
}): CheckpointIntent {
  return {
    owner: input.owner,
    request: {
      data: { command: input.command, key: input.key, viewer: input.viewer, locale: input.locale },
      headers: { 'X-CSRF-Token': input.csrfToken },
      signal: input.owner.controller.signal,
    },
    sender: input.sender,
    context: input.context,
  };
}

/** Acknowledgement and independently observed current value are separate facts. */
export function checkpointConfirmsIntent(intent: CheckpointIntent, value: CheckpointView): boolean {
  const command = intent.request.data.command;
  if (command.kind === 'clear') return value.state === 'none';
  return (
    value.state === 'saved' &&
    value.address.catalogueId === command.address.catalogueId &&
    value.address.publicationRevisionId === command.address.publicationRevisionId &&
    value.address.occurrenceId === command.address.occurrenceId &&
    value.address.targetRevisionId === command.address.targetRevisionId &&
    value.address.targetSha256 === command.address.targetSha256 &&
    sameCheckpointPosition(value.address.documentPosition, command.address.documentPosition)
  );
}
