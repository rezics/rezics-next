import type { FeedItem } from './types.ts';

/**
 * Which of a post's two identities its meta line leads with. The person is
 * the speaker and the Realm the venue that hosts them, so neither always comes
 * first (docs/plan/frontend.md, "Who a post leads with").
 */
export type MetaLead = 'person' | 'realm';

type LeadFacts = Pick<FeedItem, 'kind' | 'realm' | 'reason' | 'reasons' | 'actor' | 'group'>;

/** A pick or a decision is the Realm's act, whoever carried it out; a pick never names its curator. */
function realmAct(item: Pick<FeedItem, 'kind' | 'reasons'>): boolean {
  return item.kind === 'adoption' || item.kind === 'decision'
    || item.reasons.some(reason => reason.kind === 'realm-pick');
}

/** Whether the reader follows who posted it. Main matches a followed poster before a followed Realm. */
export function followsPoster(item: Pick<FeedItem, 'reason' | 'actor' | 'group'>): boolean {
  const { reason } = item;
  return reason.kind === 'followed' && reason.targetKind === 'agent'
    && (item.actor.id === reason.target || item.group.actors.some(actor => actor.id === reason.target));
}

/**
 * The person leads a post from someone the reader follows, and a post with
 * no Realm. The Realm leads a stranger's post, where a name says nothing yet,
 * and the Realm's own acts.
 */
export function metaLead(item: LeadFacts): MetaLead {
  if (!item.realm) return 'person';
  return !realmAct(item) && followsPoster(item) ? 'person' : 'realm';
}
