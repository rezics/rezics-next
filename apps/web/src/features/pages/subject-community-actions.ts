import { withinCommunityBytes } from './subject-community-card';
import { isRecord } from './shared';

export const COMMUNITY_ACTION_ADVICE_BYTES = 512 * 1024;
const REFERENCE_LIMIT = 2;
const OPERATION_LIMIT = 256;
const OPERATION_TEXT_LIMIT = 64;

type OperationState = 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable' | 'not_applicable';
type Operation = { action: string; operationId: string; state: OperationState };
type Reference = {
  type: 'content.thread' | 'content.post';
  id: string;
  sourceRevisionId?: string;
  state: 'current' | 'withheld';
  operations: Operation[];
};

export type CommunityActionAdvice = Readonly<{
  /** The existing thread reader owns the reply composer and post.create command. */
  reply: 'available' | 'sign_in_required' | null;
  reaction: 'available' | 'sign_in_required' | null;
  watch:
    | { state: 'current'; watching: boolean }
    | { state: 'sign_in_required' }
    | { state: 'empty' | 'denied' | 'unavailable' }
    | null;
  overflow: boolean;
}>;

const operationStates = new Set<OperationState>([
  'available',
  'sign_in_required',
  'denied',
  'withheld',
  'unavailable',
  'not_applicable',
]);
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function parseReferences(value: unknown): Reference[] | null {
  if (!Array.isArray(value) || value.length > REFERENCE_LIMIT) return null;
  const result: Reference[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, ['type', 'id', 'state', 'operations'], ['sourceRevisionId']) ||
      (candidate.type !== 'content.thread' && candidate.type !== 'content.post') ||
      !id(candidate.id) ||
      (candidate.sourceRevisionId !== undefined && !id(candidate.sourceRevisionId)) ||
      (candidate.state !== 'current' && candidate.state !== 'withheld') ||
      !Array.isArray(candidate.operations) ||
      candidate.operations.length > OPERATION_LIMIT
    )
      return null;
    const key = `${candidate.type}/${candidate.id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const operations: Operation[] = [];
    const operationIds = new Set<string>();
    for (const rawOperation of candidate.operations) {
      if (
        !isRecord(rawOperation) ||
        !exactKeys(rawOperation, ['action', 'operationId', 'state']) ||
        typeof rawOperation.action !== 'string' ||
        rawOperation.action.length > OPERATION_TEXT_LIMIT ||
        typeof rawOperation.operationId !== 'string' ||
        rawOperation.operationId.length > OPERATION_TEXT_LIMIT ||
        !operationStates.has(rawOperation.state as OperationState)
      )
        return null;
      if (operationIds.has(rawOperation.operationId as string)) return null;
      operationIds.add(rawOperation.operationId as string);
      operations.push({
        action: rawOperation.action,
        operationId: rawOperation.operationId,
        state: rawOperation.state as OperationState,
      });
    }
    result.push({
      type: candidate.type,
      id: candidate.id,
      ...(candidate.sourceRevisionId !== undefined ? { sourceRevisionId: candidate.sourceRevisionId } : {}),
      state: candidate.state,
      operations,
    });
  }
  return result;
}

function operation(reference: Reference | undefined, operationId: string, action: string) {
  const found = reference?.operations.find((candidate) => candidate.operationId === operationId);
  return found?.action === action ? found.state : undefined;
}

/**
 * Read only Content's runtime selected-card action preconditions. Generated declarations remain untouched, and
 * neither the ordinary ThreadView nor reviewContext can grant an action. The output retains only four controls.
 */
export function projectCommunityActionAdvice(
  value: unknown,
  source: { threadId: string; postRevisionId: string },
): CommunityActionAdvice | undefined {
  if (!isRecord(value) || !isRecord(value.card)) return;
  const card = value.card;
  const actions = card.actions;
  const reply = card.reply;
  const watch = card.watch;
  const currentness = card.currentness;
  if (
    card.state !== 'current' ||
    !isRecord(actions) ||
    !exactKeys(actions, ['state', 'retryable', 'references']) ||
    actions.state !== 'current' ||
    typeof actions.retryable !== 'boolean' ||
    !isRecord(reply) ||
    !exactKeys(reply, ['state']) ||
    !['available', 'sign_in_required', 'denied', 'withheld', 'unavailable'].includes(String(reply.state)) ||
    !isRecord(currentness) ||
    !exactKeys(currentness, ['source', 'place', 'authors', 'reactions', 'actions', 'watch', 'media', 'comments']) ||
    currentness.source !== 'current' ||
    currentness.place !== 'current' ||
    currentness.actions !== 'current' ||
    !['current', 'unavailable', 'not_applicable'].includes(String(currentness.authors)) ||
    !['current', 'unavailable', 'not_applicable'].includes(String(currentness.reactions)) ||
    !['current', 'unavailable', 'not_applicable'].includes(String(currentness.actions)) ||
    !['current', 'sign_in_required', 'unavailable', 'not_applicable'].includes(String(currentness.watch)) ||
    !['current', 'unavailable', 'not_applicable'].includes(String(currentness.media)) ||
    !['current', 'unavailable', 'not_applicable'].includes(String(currentness.comments)) ||
    !withinCommunityBytes({ actions, reply, watch, currentness }, COMMUNITY_ACTION_ADVICE_BYTES)
  )
    return;
  const references = parseReferences(actions.references);
  if (!references) return;
  const threadReference = references.find(
    (reference) => reference.type === 'content.thread' && reference.id === source.threadId,
  );
  const exactThread =
    threadReference?.state === 'current' && threadReference.sourceRevisionId === source.postRevisionId
      ? threadReference
      : undefined;
  const replyState = operation(exactThread, 'post.create', 'post:create');
  const replyAllowed =
    (reply.state === 'available' || reply.state === 'sign_in_required') && replyState === reply.state
      ? reply.state
      : null;

  const setReaction = operation(exactThread, 'thread.set_reaction', 'reaction:set');
  const clearReaction = operation(exactThread, 'thread.clear_reaction', 'reaction:set');
  const reaction =
    currentness.reactions === 'current' && setReaction === 'available' && clearReaction === 'available'
      ? 'available'
      : currentness.reactions === 'current' &&
          setReaction === 'sign_in_required' &&
          clearReaction === 'sign_in_required'
        ? 'sign_in_required'
        : null;

  let watchAdvice: CommunityActionAdvice['watch'] = null;
  if ((watch === null || watch === undefined) && currentness.watch === 'not_applicable') {
    watchAdvice = { state: 'empty' };
  } else if (isRecord(watch)) {
    if (
      watch.state === 'current' &&
      exactKeys(watch, ['state', 'watching']) &&
      typeof watch.watching === 'boolean' &&
      currentness.watch === 'current' &&
      operation(exactThread, watch.watching ? 'thread.unwatch' : 'thread.watch', 'thread:watch') === 'available'
    )
      watchAdvice = { state: 'current', watching: watch.watching };
    else if (
      watch.state === 'current' &&
      exactKeys(watch, ['state', 'watching']) &&
      typeof watch.watching === 'boolean' &&
      currentness.watch === 'current'
    )
      watchAdvice = { state: 'denied' };
    else if (
      watch.state === 'sign_in_required' &&
      Object.keys(watch).length === 1 &&
      currentness.watch === 'sign_in_required' &&
      operation(exactThread, 'thread.watch', 'thread:watch') === 'sign_in_required'
    )
      watchAdvice = { state: 'sign_in_required' };
    else if (
      watch.state === 'unavailable' &&
      exactKeys(watch, ['state', 'retryable']) &&
      watch.retryable === true &&
      currentness.watch === 'unavailable'
    ) {
      watchAdvice = { state: 'unavailable' };
    } else if (
      watch.state === 'withheld' &&
      exactKeys(watch, ['state']) &&
      currentness.watch !== 'unavailable'
    ) {
      watchAdvice = { state: 'denied' };
    } else return;
  } else return;

  const report = operation(exactThread, 'report.create', 'report:create');
  return {
    reply: replyAllowed,
    reaction,
    watch: watchAdvice,
    overflow: report === 'available' || report === 'sign_in_required',
  };
}
