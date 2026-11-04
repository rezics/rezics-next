import { classifyUnavailability } from '../access/unavailable.ts';
import { readViewerActions } from '../access/viewer-actions.ts';
import { AuthenticationError, type Actor } from '../request/access.ts';
import type { FeedItem, FeedReactionAdvice, FeedReactionTarget } from './feed-contract.ts';
import { REACTION_KINDS } from './events.ts';
import { feedReactionTargetFor } from './feed-reactions.ts';
import { readingPageOperationState, type ReadingPageViewerActionRuntime } from './reading-page.ts';
import type { Pool } from 'pg';

type ContentReactionItem = Extract<
  FeedItem,
  { key: { owner: 'content'; kind: 'thread' | 'post' | 'review' } }
>;
type ResourceType = 'content.thread' | 'content.post';
type SelectedReaction = Readonly<{
  target: FeedReactionTarget;
  resourceType: ResourceType;
  resourceId: string;
  contextWitness?: string;
  targetWitness: string;
  witness: string;
}>;

export type FeedReactionAdviceComposition = Readonly<{
  items: readonly FeedItem[];
  hasTargets: boolean;
  finish(items: readonly FeedItem[]): Promise<readonly FeedItem[]>;
}>;

const unavailable = (target: FeedReactionTarget): FeedReactionAdvice => ({ target, state: 'unavailable' });

function isContentReactionItem(item: FeedItem): item is ContentReactionItem {
  return (
    item.key.owner === 'content' &&
    (item.key.kind === 'thread' || item.key.kind === 'post' || item.key.kind === 'review')
  );
}

function bindingWitness(item: ContentReactionItem, contextWitness: string | undefined): string {
  return JSON.stringify({
    rowKey: item.id,
    source: item.source,
    key: item.key,
    destination: item.destination,
    summaryId: item.summary.id,
    ...(item.key.kind === 'post'
      ? { threadId: item.summary.threadId, parentContext: item.summary.parentContext ?? null }
      : {}),
    contextWitness,
  });
}

function operationIds(type: ResourceType) {
  return type === 'content.thread'
    ? ['thread.set_reaction', 'thread.clear_reaction'] as const
    : ['post.set_reaction', 'post.clear_reaction'] as const;
}

function hasReactionOperations(runtime: ReadingPageViewerActionRuntime, type: ResourceType): boolean {
  const bindings = runtime.bindings.get(type) ?? [];
  return operationIds(type).every((operationId) =>
    bindings.some((binding) => binding.action === 'reaction:set' && binding.operationId === operationId),
  );
}

export function feedReactionAdviceFromOperations(
  actor: Actor,
  target: FeedReactionTarget,
  type: ResourceType,
  operations: ReadonlySet<string>,
  guestSecurity: ReadonlyMap<string, 'anonymous' | 'authenticated' | 'unknown'>,
): FeedReactionAdvice {
  const watch = { state: 'current', watching: false } as const;
  const [setOperation, clearOperation] = operationIds(type);
  const setState = readingPageOperationState(actor, setOperation, operations, guestSecurity, watch);
  const clearState = readingPageOperationState(actor, clearOperation, operations, guestSecurity, watch);
  if (actor.kind === 'anonymous')
    return setState === 'sign_in_required' && clearState === 'sign_in_required'
      ? { target, state: 'sign_in' }
      : unavailable(target);
  if (setState === 'available' && clearState === 'available')
    return { target, state: 'current', allowed: [...REACTION_KINDS] };
  if (setState === 'denied' && clearState === 'denied') return { target, state: 'current', allowed: [] };
  return unavailable(target);
}

/** Capture exact selected occurrences now; read mounted action advice only after Home's final admission. */
export function prepareFeedReactionAdvice(
  items: readonly FeedItem[],
  contextWitnesses: ReadonlyMap<string, string>,
  dependencies: Readonly<{ pool: Pool; viewerActionRuntime?: () => ReadingPageViewerActionRuntime }>,
  actor: Actor,
  deadline: number,
): FeedReactionAdviceComposition {
  if (items.length > 20) throw new RangeError('At most 20 displayed feed items');
  const selected = new Map<string, SelectedReaction>();
  const targets = new Map<string, SelectedReaction>();
  const ambiguousTargets = new Set<string>();
  const readerWitness = JSON.stringify(actor);
  const retained = items.map((item): FeedItem => {
    if (!isContentReactionItem(item)) return item;
    const target = feedReactionTargetFor(item);
    if (!target) return item;
    const resourceType: ResourceType = target.targetKind === 'thread' ? 'content.thread' : 'content.post';
    const resourceId = target.targetId;
    const contextWitness = contextWitnesses.get(item.id);
    const targetWitness = JSON.stringify({
      target,
      ...(item.key.kind === 'post'
        ? { threadId: item.summary.threadId, parentContext: item.summary.parentContext ?? null }
        : {}),
      contextWitness,
    });
    const witness = bindingWitness(item, contextWitness);
    const row: SelectedReaction = {
      target,
      resourceType,
      resourceId,
      ...(contextWitness === undefined ? {} : { contextWitness }),
      targetWitness,
      witness,
    };
    const priorRow = selected.get(item.id);
    if (priorRow && priorRow.witness !== witness) throw new TypeError('Ambiguous feed reaction advice occurrence');
    selected.set(item.id, row);
    const targetKey = `${resourceType}/${resourceId}`;
    const priorTarget = targets.get(targetKey);
    if (priorTarget && priorTarget.targetWitness !== targetWitness) ambiguousTargets.add(targetKey);
    else targets.set(targetKey, row);
    const { reactionAdvice: _previous, ...summary } = item.summary;
    return { ...item, summary };
  });

  let finished = false;
  return {
    items: retained,
    hasTargets: selected.size > 0,
    async finish(admittedItems) {
      if (finished) throw new TypeError('Retired feed reaction advice preparation');
      finished = true;
      const live = new Map<string, SelectedReaction>();
      for (const item of admittedItems) {
        if (!isContentReactionItem(item)) continue;
        const original = selected.get(item.id);
        if (!original || original.witness !== bindingWitness(item, original.contextWitness)) continue;
        live.set(item.id, original);
      }
      if (!live.size) return admittedItems;

      const activeTargets = new Map<string, SelectedReaction>();
      for (const original of live.values())
        if (original.contextWitness !== undefined) {
          const targetKey = `${original.resourceType}/${original.resourceId}`;
          if (!ambiguousTargets.has(targetKey)) activeTargets.set(targetKey, original);
        }

      const adviceByTarget = new Map<string, FeedReactionAdvice>();
      for (const original of live.values())
        adviceByTarget.set(`${original.resourceType}/${original.resourceId}`, unavailable(original.target));

      if (JSON.stringify(actor) === readerWitness && activeTargets.size) {
        let runtime: ReadingPageViewerActionRuntime | undefined;
        try {
          runtime = dependencies.viewerActionRuntime?.();
        } catch (error) {
          if (error instanceof AuthenticationError) throw error;
          if (classifyUnavailability(error) === 'deadline') throw error;
          if (classifyUnavailability(error) === undefined) throw error;
        }
        if (runtime) {
          const supported = [...activeTargets.values()].filter(
            (entry) => runtime!.resources.has(entry.resourceType) && hasReactionOperations(runtime!, entry.resourceType),
          );
          const references = [
            ...new Map(
              supported.map((entry) => [
                `${entry.resourceType}/${entry.resourceId}`,
                { type: entry.resourceType, id: entry.resourceId },
              ]),
            ).values(),
          ];
          if (references.length) {
            try {
              const result = await readViewerActions(
                { pool: dependencies.pool, ...runtime },
                actor,
                references,
                deadline,
              );
              const observed = new Map(result.resources.map((entry) => [`${entry.type}/${entry.id}`, entry]));
              for (const [targetKey, original] of activeTargets) {
                if (!supported.some((entry) => `${entry.resourceType}/${entry.resourceId}` === targetKey)) continue;
                const resource = observed.get(targetKey);
                if (!resource || !('viewerActions' in resource)) continue;
                const operations = new Set(
                  resource.viewerActions
                    .filter((entry) => entry.action === 'reaction:set')
                    .flatMap((entry) => entry.operations),
                );
                adviceByTarget.set(
                  targetKey,
                  feedReactionAdviceFromOperations(
                    actor,
                    original.target,
                    original.resourceType,
                    operations,
                    runtime.guestSecurity,
                  ),
                );
              }
            } catch (error) {
              if (error instanceof AuthenticationError) throw error;
              const classification = classifyUnavailability(error);
              if (classification === 'deadline' || classification === undefined) throw error;
            }
          }
        }
      }

      return admittedItems.map((item): FeedItem => {
        if (!isContentReactionItem(item)) return item;
        const original = live.get(item.id);
        if (!original) return item;
        const advice = adviceByTarget.get(`${original.resourceType}/${original.resourceId}`);
        return advice ? { ...item, summary: { ...item.summary, reactionAdvice: advice } } : item;
      });
    },
  };
}
