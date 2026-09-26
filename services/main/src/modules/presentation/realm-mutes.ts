export interface ActivePresentationMute {
  targetKind: 'realm' | 'agent';
  target: string;
  match: 'publishing-realm' | 'author-membership' | 'publication-context' | 'author';
}

/** Presentation facts supplied by a feed or search result's owning read model. */
export interface PresentationMuteFacts {
  author: string | null;
  publishingRealm: string | null;
  authorMembershipRealms: readonly string[];
  publicationContext: string | null;
}

export interface PresentationMuteFilter {
  hides(facts: PresentationMuteFacts): boolean;
  visible<T extends PresentationMuteFacts>(items: readonly T[]): T[];
}

/**
 * Builds a bounded, principal-specific presentation filter from Access's active
 * mute selection. This is a presentation decision only; callers must still use
 * Access for interaction admission and resource access.
 */
export function createPresentationMuteFilter(mutes: readonly ActivePresentationMute[]): PresentationMuteFilter {
  const authors = new Set<string>();
  const publishingRealms = new Set<string>();
  const authorMembershipRealms = new Set<string>();
  const publicationContexts = new Set<string>();
  for (const mute of mutes) {
    if (mute.targetKind === 'agent' && mute.match === 'author') authors.add(mute.target);
    if (mute.targetKind === 'realm') {
      if (mute.match === 'publishing-realm') publishingRealms.add(mute.target);
      if (mute.match === 'author-membership') authorMembershipRealms.add(mute.target);
      if (mute.match === 'publication-context') publicationContexts.add(mute.target);
    }
  }
  const hides = (facts: PresentationMuteFacts) =>
    (facts.author !== null && authors.has(facts.author))
      || (facts.publishingRealm !== null && publishingRealms.has(facts.publishingRealm))
      || facts.authorMembershipRealms.some(realm => authorMembershipRealms.has(realm))
      || (facts.publicationContext !== null && publicationContexts.has(facts.publicationContext));
  return {
    hides,
    visible(items) { return items.filter(item => !hides(item)); },
  };
}
