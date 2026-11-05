import { accessCheck, type AccessCheck, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { partitionReadClients } from '../database/read-snapshot.ts';
import { withReadTransaction } from '../access/read-transaction.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import type { FeedItem, FeedSubjectReactionKind, FeedSubjectReactions } from './feed-contract.ts';
import { withReactionCountsAndCoverage, withViewerReactions, type ContentReadDependencies } from './reads.ts';
import identities from './feed-subject-reactions.sql';

const kinds = ['like', 'love', 'laugh', 'insightful', 'sad'] as const;
const isKind = (value: string): value is FeedSubjectReactionKind => kinds.some((kind) => kind === value);
type SubjectItem = Extract<FeedItem, { destination: { kind: 'subject' } }>;
type Identity = Readonly<{ id: string; type: string; securityRevision: string; redirect: string | null }>;
export type FeedSubjectReactionComposition = Readonly<{
  /** Invoke after foreign hydration and before the page's final source witnesses.
   * Failure must rewind every represented lane to its exact input frontier. */
  finish(): Promise<readonly FeedItem[]>;
}>;

/** Prepare only the displayed page, never raw candidates or Semantic's shared summaries.
 * All foreign preparation ends before any retained native snapshot begins. */
export async function prepareFeedSubjectReactions(
  dependencies: ContentReadDependencies,
  actor: Actor,
  items: readonly FeedItem[],
  deadline: number,
): Promise<FeedSubjectReactionComposition> {
  if (items.length > 20) throw new RangeError('At most 20 displayed feed items');
  const selected = new Map<string, SubjectItem>();
  const retained = items.map((item) => {
    if (item.key.owner !== 'semantic') return item;
    if (
      item.destination.kind !== 'subject' ||
      item.key.id !== item.destination.id ||
      item.key.id !== item.summary.id ||
      !('type' in item.summary) ||
      item.key.kind !== item.summary.type ||
      routeOf(item.key.id) !== item.key.route
    )
      throw new TypeError('Ambiguous feed Subject reaction target');
    const prior = selected.get(item.key.id);
    if (prior && prior.summary.type !== item.summary.type)
      throw new TypeError('Ambiguous feed Subject reaction target');
    const copy = structuredClone(item) as SubjectItem;
    // No previous page or producer can supply a private baseline to this read.
    delete copy.summary.subjectReactions;
    selected.set(item.key.id, copy);
    return copy;
  });
  if (!selected.size) return { finish: async () => retained };

  const readerWitness = JSON.stringify(actor);
  let finished = false;
  const context = { pool: dependencies.pool, deadline };
  const checks = new Map<string, AccessCheck>();
  const groups = new Map<number, string[]>();
  for (const id of selected.keys()) {
    const route = routeOf(id)!;
    const home = partitionOf(route);
    groups.set(home, [...(groups.get(home) ?? []), id]);
    checks.set(
      id,
      await accessCheck(
        dependencies.access,
        actor,
        'subject:read',
        {
          route,
          id,
          eligibility: subjectReadEligibility({ route, id }),
        },
        context,
      ),
    );
  }
  // Advice uses the writer's Global Context operand, never a Subject-local grant.
  const advice =
    actor.kind === 'account'
      ? await accessCheck(dependencies.access, actor, 'reaction:set', { route: 0, id: GLOBAL_CONTEXT }, context)
      : undefined;
  const observe = () =>
    withReadTransaction(
      dependencies.pool,
      async (client) => {
        await partitionReadClients(client, [...groups.keys(), ...(advice ? [0] : [])]);
        const observed = new Map<string, Identity>();
        for (const [partition, ids] of groups) {
          const parameters = { partition, ids, routes: ids.map((id) => routeOf(id)!) };
          const result = await client.query<(typeof identities)['~reylo']['element']>(
            identities.sql,
            identities.params.map((name) => parameters[name as keyof typeof parameters]),
          );
          for (const row of result.rows) {
            if (
              typeof row.id !== 'string' ||
              typeof row.type !== 'string' ||
              typeof row.securityRevision !== 'string' ||
              !ids.includes(row.id) ||
              observed.has(row.id)
            )
              throw new TypeError('Unexpected feed Subject identity');
            const item = selected.get(row.id)!;
            if (row.redirect !== null || row.type !== item.summary.type || !(await checks.get(row.id)!(client)))
              continue;
            observed.set(row.id, {
              id: row.id,
              type: row.type,
              securityRevision: row.securityRevision,
              redirect: row.redirect,
            });
          }
        }
        return { observed, allowed: advice ? await advice(client) : false };
      },
      deadline,
    );

  const initial = await observe();
  return {
    async finish() {
      if (finished || JSON.stringify(actor) !== readerWitness)
        throw new TypeError('Retired feed Subject reaction preparation');
      // A retry opens a new preparation at the same page frontier. This handle
      // must never replay a retained viewer slot in another request lifetime.
      finished = true;
      const targets = [...initial.observed.keys()].map((id) => ({ id }));
      // Native totals retain coverage and source watermarks, including zero rows after
      // a clear. A missing row is unknown; it is never manufactured as a zero map.
      const counted = await withReactionCountsAndCoverage(dependencies, targets, deadline);
      const viewed = await withViewerReactions(dependencies, actor, counted.items, deadline);
      const coverage = new Map(counted.targetFreshness.map(({ id, source }) => [id, source]));
      const projections = new Map<string, FeedSubjectReactions>();
      for (const target of viewed) {
        const values: Partial<Record<FeedSubjectReactionKind, number>> = {};
        for (const [kind, count] of Object.entries(target.reactions)) {
          if (!isKind(kind)) throw new TypeError('Invalid feed Subject reaction kind');
          values[kind] = count;
        }
        const source = coverage.get(target.id);
        const viewerKind = target.viewerReaction;
        if (viewerKind !== undefined && viewerKind !== null && !isKind(viewerKind))
          throw new TypeError('Invalid feed Subject viewer reaction kind');
        projections.set(target.id, {
          target: { targetKind: 'subject', targetId: target.id },
          counts: source ? { state: 'available', values, asOf: source } : { state: 'unavailable' },
          ...(actor.kind === 'account'
            ? {
                viewer:
                  Object.hasOwn(target, 'viewerReaction') && viewerKind !== undefined
                    ? { state: 'available' as const, kind: viewerKind }
                    : { state: 'unavailable' as const },
              }
            : {}),
          action: actor.kind === 'anonymous' ? 'sign_in' : source ? 'denied' : 'unavailable',
        });
      }
      // Re-evaluate prepared Access/account evidence and exact identity after every
      // count/slot checkout. An alias change retires the original card entirely.
      const final = await observe();
      return retained.flatMap((item): FeedItem[] => {
        if (item.key.owner !== 'semantic') return [item];
        const before = initial.observed.get(item.key.id);
        const after = final.observed.get(item.key.id);
        const projection = projections.get(item.key.id);
        if (!before || !after || !projection || before.securityRevision !== after.securityRevision) return [];
        const subjectReactions: FeedSubjectReactions = {
          ...projection,
          action:
            actor.kind === 'anonymous'
              ? 'sign_in'
              : projection.counts.state !== 'available' || projection.viewer?.state !== 'available'
                ? 'unavailable'
                : final.allowed
                  ? 'allowed'
                  : 'denied',
        };
        return [{ ...item, summary: { ...item.summary, subjectReactions } } as SubjectItem];
      });
    },
  };
}
