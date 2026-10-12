import {
  captureDisclosure, DISCLOSURE_COST, DisclosureUnavailable, fenceDisclosure,
  resolveDisclosureSelections, type DisclosureReadCut, type DisclosureTarget,
} from '../disclosure/read.ts';
import { WorkReadMissing, type WorkReadSession } from '../work/read-session.ts';
import { FEED_COST } from './contract.ts';
import { feedReviewSources, feedSources, type FeedSource } from './source.ts';

type FeedSession = Pick<WorkReadSession, 'deps' | 'viewer' | 'realm' | 'fenceRealms'>;
export type FeedDisclosureOccurrence = Pick<FeedSource, 'id' | 'kind' | 'target' | 'work' | 'realm'
  | 'reply' | 'contentTarget' | 'contentRevision' | 'readerReview'>;

/** Hydration reuses exact-read bytes, so freeze an owned snapshot rather than
 * keeping caller-owned references to the publication admitted at capture. */
function snapshot<Source>(source: Source): Source {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  const copy = structuredClone(source);
  freeze(copy);
  return copy;
}

/** The retained activity selects an occurrence, not an alternate placement of
 * the same Work. Its owner must revalidate publication, preparation and approval
 * when resolving and rereading this reference. Context is only a lookup hint. */
export function closedRealmFeedTargets(source: FeedDisclosureOccurrence): readonly DisclosureTarget[] {
  if (source.reply && !source.realm || (source.reply || source.contentTarget)
    && !source.contentRevision?.match(/^urn:rezics:content:revision:.+$/)
    || source.kind === 'review' && !source.readerReview?.revision)
    throw new DisclosureUnavailable('Feed publication reference is incomplete');
  const occurrence = {
    owner: source.kind === 'review' ? 'review' as const : 'graph' as const,
    kind: source.reply ? 'realm-placement' as const : source.kind === 'adoption' ? 'realm-selection' as const
      : source.realm ? 'work-in-realm' as const : 'publication' as const,
    resource: source.id,
    revision: source.readerReview?.revision ?? source.id,
  };
  const common = { work: source.work, context: source.realm ?? undefined, occurrence };
  const activity: DisclosureTarget = { ...common, owner: source.kind === 'review' ? 'review' : 'graph',
    resource: source.id, component: 'body', revision: source.readerReview?.revision };
  // A review body belongs to Review; asking Content for it invents a publication.
  if (source.kind === 'review') return [activity];
  return [activity, { ...common, owner: 'content',
    resource: source.reply ?? source.contentTarget ?? source.target, component: 'body',
    revision: source.contentRevision?.replace(/^urn:rezics:content:revision:/, '') ?? null }];
}

/** Capture after current-source admission and before grouping, ranking, counts
 * or card hydration. Every reader class uses the same disclosure owner. */
export async function captureClosedRealmFeedSources<Source extends FeedDisclosureOccurrence>(session: FeedSession,
  sources: readonly Source[], channel: 'feed' | 'count' = 'feed') {
  if (sources.length > FEED_COST.refreshItems || new Set(sources.map(source => source.id)).size !== sources.length)
    throw new DisclosureUnavailable('Feed occurrence batch is invalid');
  sources = sources.map(source => snapshot(source));
  const env = session.deps.environment, viewer = session.viewer;
  const realms = [...new Set(sources.flatMap(source => source.realm ? [source.realm] : []))];
  for (const realm of realms) await session.realm(realm);
  const targets = sources.flatMap(source => [...closedRealmFeedTargets(source)]);
  if (targets.length > DISCLOSURE_COST.batch) throw new DisclosureUnavailable('Feed disclosure budget exceeded');
  const selections = targets.length ? await resolveDisclosureSelections(env, targets) : [];
  let offset = 0;
  const entries = sources.map(source => {
    const selected = selections.slice(offset, offset += closedRealmFeedTargets(source).length);
    // A missing Realm descriptor must never turn a Realm event into an original.
    if (selected.some(selection => (selection.ancestry.parents.find(parent => parent.kind === 'realm')?.resource ?? null)
      !== source.realm)) throw new DisclosureUnavailable('Feed Realm ancestry differs');
    return { source, selected };
  });
  const cuts = selections.length ? await captureDisclosure(env, selections, viewer, channel) : [];
  const bySelection = new Map(selections.map((selection, index) => [selection, cuts[index]!]));
  const admitted = entries.map(entry => ({ source: entry.source,
    cuts: entry.selected.map(selection => bySelection.get(selection)!) }));
  const visible = (decisions: ReadonlyMap<DisclosureReadCut, string>) => admitted
    .filter(entry => entry.cuts.every(cut => decisions.get(cut) === 'visible')).map(entry => entry.source);
  return {
    sources: visible(new Map(cuts.map(cut => [cut, cut.decision]))),
    /** Use the survivors to rebuild groups, attribution and cursor Realm history.
     * A sparse page may advance by its retained position; it must not retain a
     * hidden Realm in continuation metadata or substitute another occurrence. */
    fence: async () => {
      await session.fenceRealms();
      for (const realm of realms) await session.realm(realm);
      const decisions = cuts.length ? await fenceDisclosure(env, cuts, viewer, channel) : [];
      return visible(new Map(cuts.map((cut, index) => [cut, decisions[index]!])));
    },
  };
}

/** Current publication/placement admission stays with the existing feed owner. */
export async function readClosedRealmFeedSources(session: WorkReadSession,
  rows: readonly { id: string; kind: string }[]) {
  if (rows.length > FEED_COST.refreshItems) throw new DisclosureUnavailable('Feed source budget exceeded');
  const [activities, reviews] = await Promise.all([
    feedSources(session, { ids: rows.filter(row => row.kind !== 'review').map(row => row.id) }),
    feedReviewSources(session, rows.filter(row => row.kind === 'review').map(row => row.id)),
  ]);
  return captureClosedRealmFeedSources(session, [...activities, ...reviews]);
}

/** Hidden and nonexistent Realm scopes use the route's ordinary missing result. */
export async function captureClosedRealmFeedScope(session: FeedSession, realm: string) {
  const env = session.deps.environment, viewer = session.viewer;
  await session.realm(realm);
  const selections = await resolveDisclosureSelections(env, [{ owner: 'graph', resource: realm, component: 'record' }]);
  if (selections[0]?.ancestry.resourceKind !== 'realm') throw new WorkReadMissing('Realm unavailable');
  const cuts = await captureDisclosure(env, selections, viewer, 'feed');
  if (cuts[0]?.decision !== 'visible') throw new WorkReadMissing('Realm unavailable');
  return async () => {
    await session.fenceRealms();
    await session.realm(realm);
    if ((await fenceDisclosure(env, cuts, viewer, 'feed'))[0] !== 'visible')
      throw new WorkReadMissing('Realm unavailable');
  };
}
