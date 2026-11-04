import type { SubjectLibraryMutation, SubjectLibraryMutationResponse } from '../library/subject-slot';
import type {
  DiscoveryCommandResult,
  DiscoveryPersonalPage,
  DiscoveryPersonalTarget,
} from './discovery-personal-state';

/** Profile/exposure evidence comes from the page host, separately from entry existence. */
export type DiscoveryEntryCapability =
  | {
      state: 'ready';
      states: readonly { id: string; label: { text: string; lang: string } }[];
      save: boolean;
      remove: boolean;
    }
  | { state: 'unknown' | 'signed-out' | 'unsupported' | 'concealed' | 'unavailable' };

export function discoveryEntryOutcome(response: SubjectLibraryMutationResponse): DiscoveryCommandResult {
  if (response.result === 'saved' || response.result === 'cleared') return 'successful';
  if (
    response.result === 'conflict' ||
    response.result === 'unsupported_library_profile' ||
    response.result === 'closed'
  )
    return 'rejected';
  // The existing native adapter deliberately conceals transport details. Never infer a rejection or resend.
  return 'uncertain';
}

/** Construct only the installed native entry command, retaining the observed incarnation and revision. */
export function discoveryEntryInput(
  target: DiscoveryPersonalTarget,
  capability: DiscoveryEntryCapability,
  action: { state: string } | { remove: true },
  idempotencyKey: string,
): SubjectLibraryMutation | undefined {
  if (capability.state !== 'ready' || target.entry.state === 'unavailable') return;
  if ('remove' in action) {
    if (!capability.remove || target.entry.state !== 'present' || target.entry.revision < 1) return;
    return {
      intent: 'entry',
      subjectId: target.subjectId,
      action: 'clear',
      revision: target.entry.revision,
      incarnationId: target.entry.incarnationId,
      idempotencyKey,
    };
  }
  if (!capability.save || !capability.states.some((state) => state.id === action.state)) return;
  if (target.entry.state === 'present' && target.entry.revision < 1) return;
  return {
    intent: 'entry',
    subjectId: target.subjectId,
    action: 'save',
    state: action.state,
    idempotencyKey,
    ...(target.entry.state === 'present'
      ? { revision: target.entry.revision, incarnationId: target.entry.incarnationId }
      : {}),
  };
}

/** A controlled adapter; the host supplies its current-reader wrapper of mutateSubjectLibrarySlot. */
export function changeDiscoveryEntry(input: {
  page: DiscoveryPersonalPage;
  rowKey: string;
  capability: DiscoveryEntryCapability;
  action: { state: string } | { remove: true };
  write: (command: SubjectLibraryMutation) => Promise<SubjectLibraryMutationResponse>;
}) {
  // Clone before yielding so an external capability or draft cannot change a dispatched command.
  const capability = structuredClone(input.capability);
  const action = structuredClone(input.action);
  return input.page.execute(input.rowKey, 'entry', async (target, idempotencyKey) => {
    const command = discoveryEntryInput(target, capability, action, idempotencyKey);
    if (!command) return 'rejected';
    return discoveryEntryOutcome(await input.write(command));
  });
}

export type DiscoveryVoteCapability =
  | { state: 'ready'; set: boolean; clear: boolean }
  | { state: 'unknown' | 'signed-out' | 'unsupported' | 'concealed' | 'unavailable' };
export type DiscoveryVoteInput = {
  subjectId: string;
  question: NonNullable<DiscoveryPersonalTarget['question']>;
  units: number | null;
  idempotencyKey: string;
};
export function changeDiscoveryVote(input: {
  page: DiscoveryPersonalPage;
  rowKey: string;
  capability: DiscoveryVoteCapability;
  units: number | null;
  write: (command: DiscoveryVoteInput) => Promise<DiscoveryCommandResult>;
}) {
  const capability = structuredClone(input.capability);
  const units = input.units;
  return input.page.execute(input.rowKey, 'vote', async (target, idempotencyKey) => {
    const q = target.question;
    if (
      capability.state !== 'ready' ||
      !q ||
      target.vote.state === 'unavailable' ||
      target.vote.questionId !== q.id ||
      target.vote.questionRevision !== q.revision ||
      (units === null
        ? !capability.clear || target.vote.state !== 'present'
        : !capability.set ||
          !Number.isSafeInteger(units) ||
          units < q.scale.min ||
          units > q.scale.max ||
          (units - q.scale.min) % q.scale.displayStep !== 0)
    )
      return 'rejected';
    return input.write({ subjectId: target.subjectId, question: q, units, idempotencyKey });
  });
}
