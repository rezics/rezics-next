import type { ContributionActionsInput, ContributionActionsResponse, ContributionReference } from './receiver';

const uuid = (value: string) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const closed = (value: object, required: readonly string[], optional: readonly string[] = []) =>
  !!value && typeof value === 'object' && !Array.isArray(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const status = (state: string) => state === 'current' || state === 'unavailable';
const watchStatus = (state: string) => status(state) || state === 'sign_in_required';
const operationStatus = (state: string) => ['available', 'sign_in_required', 'denied', 'withheld', 'unavailable', 'not_applicable'].includes(state);
const list = <T,>(values: T[], max: number, valid: (value: T) => boolean) =>
  Array.isArray(values) && values.length <= max && values.every(valid);
const unique = <T,>(values: T[], key: (value: T) => string) => new Set(values.map(key)).size === values.length;
const targetKey = (value: { type: string; id: string }) => `${value.type}:${value.id}`;

export function sameContributionReference(left: ContributionReference, right: ContributionReference): boolean {
  return left.type === right.type && left.id === right.id && left.placeId === right.placeId &&
    left.sourceRevisionId === right.sourceRevisionId &&
    (left.type !== 'content.post' || (right.type === 'content.post' && left.threadId === right.threadId && left.threadRevisionId === right.threadRevisionId));
}

/** Validate the closed HTTP response in its official callable type; never promote unknown receiver data. */
export function validateContributionActionsResponse(input: ContributionActionsInput, value: ContributionActionsResponse): ContributionActionsResponse {
  const targets = new Set(input.references.flatMap((reference) => reference.type === 'content.post'
    ? [targetKey(reference), `content.thread:${reference.threadId}`] : [targetKey(reference)]));
  const threads = new Set(input.references.map((reference) => reference.type === 'content.post' ? reference.threadId : reference.id));
  const valid = closed(value, ['viewer', 'selected', 'reactions', 'actions', 'watch', 'currentness']) &&
    (value.viewer?.kind === 'account' ? closed(value.viewer, ['kind', 'id']) && uuid(value.viewer.id) :
      value.viewer?.kind === 'anonymous' && closed(value.viewer, ['kind'])) &&
    list(value.selected, 20, (selected) => {
      if (!closed(selected, ['reference', 'state', 'reply']) || !selected.reference) return false;
      const reference = selected.reference;
      const original = input.references.find((item) => item.type === reference.type && item.id === reference.id);
      return !!original && sameContributionReference(reference, original) &&
        closed(reference, reference.type === 'content.post' ? ['type', 'id', 'threadId', 'placeId', 'threadRevisionId', 'sourceRevisionId'] : ['type', 'id', 'placeId', 'sourceRevisionId']) &&
        ['current', 'erased', 'withheld'].includes(selected.state) && closed(selected.reply, ['state']) &&
        ['available', 'sign_in_required', 'denied', 'withheld', 'unavailable'].includes(selected.reply.state);
    }) && value.selected.length === input.references.length && unique(value.selected, (item) => targetKey(item.reference)) &&
    closed(value.reactions, ['state', 'retryable', 'items', 'reactionsAsOf']) && status(value.reactions.state) && typeof value.reactions.retryable === 'boolean' &&
    list(value.reactions.items, 60, (item) => closed(item, ['type', 'id', 'state'], ['counts', 'viewerSelection']) &&
      targets.has(targetKey(item)) && (status(item.state) || item.state === 'not_applicable') &&
      (item.counts === undefined || (closed(item.counts, [], ['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad']) && Object.values(item.counts).every((count) => Number.isSafeInteger(count) && count >= 0))) &&
      (!Object.hasOwn(item, 'viewerSelection') || item.viewerSelection === null || (typeof item.viewerSelection === 'string' && item.viewerSelection.length <= 32))) &&
    unique(value.reactions.items, targetKey) &&
    (value.reactions.reactionsAsOf === null || (closed(value.reactions.reactionsAsOf, ['epoch', 'position']) && Number.isSafeInteger(value.reactions.reactionsAsOf.epoch) && value.reactions.reactionsAsOf.epoch >= 1 && typeof value.reactions.reactionsAsOf.position === 'string' && /^\d+$/.test(value.reactions.reactionsAsOf.position))) &&
    closed(value.actions, ['state', 'retryable', 'references']) && status(value.actions.state) && typeof value.actions.retryable === 'boolean' &&
    list(value.actions.references, 60, (reference) => closed(reference, ['type', 'id', 'state', 'operations'], ['sourceRevisionId']) &&
      targets.has(targetKey(reference)) && (reference.state === 'current' || reference.state === 'withheld') &&
      (reference.sourceRevisionId === undefined || uuid(reference.sourceRevisionId)) &&
      list(reference.operations, 256, (operation) => closed(operation, ['action', 'operationId', 'state']) && typeof operation.action === 'string' && typeof operation.operationId === 'string' && operationStatus(operation.state)) &&
      unique(reference.operations, (operation) => `${operation.action}:${operation.operationId}`)) && unique(value.actions.references, targetKey) &&
    closed(value.watch, ['state', 'retryable', 'items']) && watchStatus(value.watch.state) && typeof value.watch.retryable === 'boolean' &&
    list(value.watch.items, 20, (item) => closed(item, ['threadId', 'state'], ['watching']) && threads.has(item.threadId) && watchStatus(item.state) && (item.watching === undefined || typeof item.watching === 'boolean')) && unique(value.watch.items, (item) => item.threadId) &&
    closed(value.currentness, ['source', 'place', 'reactions', 'authors', 'actions', 'watch']) && value.currentness.source === 'current' && value.currentness.place === 'current' && status(value.currentness.reactions) && status(value.currentness.authors) && status(value.currentness.actions) && watchStatus(value.currentness.watch);
  if (!valid) throw new Error('Invalid author contribution actions response');
  return value;
}
