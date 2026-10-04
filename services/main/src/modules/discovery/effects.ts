import type { OwnedDiscoveryBasis } from './contract.ts';
import { standingRatingSlotIri } from '../rating/observation.ts';

export type DiscoveryEffect = 'irrelevant' | 'work' | 'scope';
/** Exhaustive command classification, guarded against the relay handler registry.
 * Definitions/protection without a bounded target name a rare rebuild. Display
 * labels, bodies, follows, Zone layouts and unrelated owner inventories are live
 * hydration inputs, not standing discovery scores or population membership. */
export const DISCOVERY_EFFECTS: Readonly<Record<string, DiscoveryEffect>> = {
  'work.create': 'work',
  'work.edit': 'work',
  'work.derive': 'work',
  'work.title.apply': 'work',
  'work.title.return': 'work',
  'contribution.create': 'work',
  'contribution.edit': 'irrelevant',
  'contribution.publish': 'work',
  'publication.select': 'work',
  'source.project': 'scope',
  'catalogue.verify': 'work',
  'identity.merge': 'scope',
  'classification.decision.set': 'work',
  'classification.global.bootstrap': 'scope',
  'classification.context.configure': 'scope',
  'classification.proposition.define': 'scope',
  'rating.observation.set': 'work',
  'rating.context.create': 'scope',
  'rating.context.policy.set': 'scope',
  'work.protection.tighten': 'work',
  'work.protection.confirm': 'work',
  'work.protection.relax': 'work',
  'work.correction.propose': 'irrelevant',
  'work.correction.review': 'work',
  'structure.command': 'irrelevant',
  'structure.project': 'irrelevant',
  'structure.stage-cancel': 'irrelevant',
  'studio.chapter.create': 'work',
  'erasure.graph': 'scope',
  'governance.moderation.apply': 'scope',
  'realm.policy.publish': 'scope',
  'space.create': 'irrelevant',
  'publication.adopt': 'irrelevant',
  'publication.reject': 'irrelevant',
  'publication.reject.organization': 'irrelevant',
  'translation.link': 'irrelevant',
  'translation.authorize': 'irrelevant',
  'release.seal': 'irrelevant',
  'address.claim': 'irrelevant',
  'address.rename': 'irrelevant',
  'address.dispose': 'irrelevant',
  'address.migrate': 'irrelevant',
  'agent.provision': 'irrelevant',
  'agent.compensate': 'irrelevant',
  'agent.profile.change': 'irrelevant',
  'zone.edit': 'irrelevant',
  'collection.edit': 'irrelevant',
  'relation.change': 'irrelevant',
  'projection.create': 'irrelevant',
  'event.observation.set': 'irrelevant',
  'package.recommendation.set': 'irrelevant',
  'reply.place': 'irrelevant',
  'submission.submit': 'irrelevant',
  'realm.moderator.choose': 'irrelevant',
  'realm.profile.publish': 'irrelevant',
  'theme.activate': 'irrelevant',
  'theme.approve': 'irrelevant',
  'theme.control': 'irrelevant',
  'theme.create': 'irrelevant',
  'theme.review': 'irrelevant',
  'theme.revise': 'irrelevant',
  'theme.revoke': 'irrelevant',
  'content.publish': 'irrelevant',
  'content.search-eligibility': 'irrelevant',
  'content.project': 'irrelevant',
  'content.private-project': 'irrelevant',
  'content.rebuild.activate': 'irrelevant',
  'content.rebuild.clear': 'irrelevant',
  'content.rebuild.cleared': 'irrelevant',
  'content.rebuild.profile': 'irrelevant',
  'content.rebuild.quarantine': 'irrelevant',
  'context.change': 'scope',
  'context.create': 'irrelevant',
  'context.definition.state': 'scope',
  'context.equivalence.review': 'scope',
  'context.preference': 'irrelevant',
  'context.rule.change': 'scope',
  'context.rule.depend': 'scope',
  'context.select': 'scope',
  'context.state': 'scope',
  'semantic.change': 'scope',
  'semantic.change.bulk': 'scope',
  'model.generation.record': 'scope',
  'lexicon.presentation.change': 'irrelevant',
  'lexicon.presentation.review': 'irrelevant',
  'rating.question-presentation.change': 'irrelevant',
  'rating.question-presentation.review': 'irrelevant',
  'statement.record': 'scope',
  'statement.withdraw': 'scope',
  'statement.decide': 'scope',
  'statement.migrate': 'scope',
  'statement.cutover': 'scope',
  'governance.ballot.invalidate': 'irrelevant',
  'governance.ballot.operate': 'irrelevant',
  'governance.poll.administer': 'irrelevant',
  'governance.proposal.execute': 'irrelevant',
  'governance.seat.manage': 'irrelevant',
  'rights.offer-create': 'irrelevant',
  'rights.offer-end': 'irrelevant',
  'rights.offer-invalidate': 'irrelevant',
  'rights.offer-recognize': 'irrelevant',
  'verification.claim-assess': 'irrelevant',
  'verification.claim-create': 'irrelevant',
  'verification.reliability-assess': 'irrelevant',
};
const nativeWork = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export interface DiscoveryEventInput {
  action: string;
  outcome?: string;
  work?: string;
  mainVersion?: string;
  target?: string;
  ratingContext?: string;
  ratingSlot?: string;
  realm?: string;
  chapterWork?: string;
  commandAction?: string;
}
export function discoveryEventEffect(
  event: DiscoveryEventInput,
  basis?: OwnedDiscoveryBasis,
): DiscoveryEffect | undefined {
  const effect = DISCOVERY_EFFECTS[event.action];
  if (!effect) return undefined;
  if (event.outcome === 'cancelled' || event.outcome === 'stale' || event.outcome === 'denied')
    return 'irrelevant';
  // Discover reads MainVersion aggregates. A structural grain's owning Work
  // does not make its exact target's rating part of that population.
  if (
    event.action === 'rating.observation.set' &&
    event.target &&
    event.target !== event.mainVersion
  )
    return 'irrelevant';
  if (basis && event.action.startsWith('rating.')) {
    if (!basis.context || event.ratingContext !== basis.context) return 'irrelevant';
    if (
      basis.scope === 'mine' &&
      event.action === 'rating.observation.set' &&
      event.mainVersion &&
      event.ratingSlot !== standingRatingSlotIri(basis.owner!, basis.context, event.mainVersion)
    )
      return 'irrelevant';
  }
  if (
    basis?.scope === 'mine' &&
    (event.action.startsWith('classification.') ||
      event.action.startsWith('statement.') ||
      event.action.startsWith('context.') ||
      event.action.startsWith('semantic.') ||
      event.action === 'model.generation.record')
  )
    return 'irrelevant';
  if (
    basis &&
    event.action === 'realm.policy.publish' &&
    (basis.scope !== 'realm' || event.realm !== basis.realm)
  )
    return 'irrelevant';
  // Structure edits stage placements. Only book activation changes the public
  // standalone Work population; other profiles remain display/structure reads.
  if (event.action === 'structure.command')
    return ['composition.create', 'composition.seal', 'structure.measures'].includes(
      event.commandAction ?? '',
    )
      ? 'irrelevant'
      : 'scope';
  return effect;
}
export function discoveryEventWorks(event: DiscoveryEventInput): string[] | null {
  const works = [event.work ?? event.chapterWork].filter((value): value is string => !!value);
  return works.length && works.every((value) => nativeWork.test(value)) ? works : null;
}
