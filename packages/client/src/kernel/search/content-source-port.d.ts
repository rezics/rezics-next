/** Search-owned Content and Community capabilities used by Realm scope, review discovery and Space indexing. */
type ContentKnowledgeApi = Pick<typeof import('../content/index.ts'), 'createKnowledgeDiscoverySource'>;
type ContentRealmApi = Pick<typeof import('../content/realm-subject-source.ts'), 'createRealmSubjectSource'>;
type ContentReviewApi = Pick<typeof import('../content/review-discovery.ts'), 'createReviewDiscoverySource' | 'REVIEW_DISCOVERY_PAGE_LIMIT' | 'REVIEW_DISCOVERY_READ_LIMIT'>;
type ContentReviewChangeApi = Pick<typeof import('../content/review-discovery-changes.ts'), 'readReviewDiscoveryChanges' | 'refreshReviewDiscoveryChanges'>;
type CommunitySpaceApi = Pick<typeof import('../community/space-discovery.ts'), 'spaceDiscoveryInvalidation' | 'SPACE_DISCOVERY_NATIVE_EVENTS'>;
export type SearchContentSourcePort = Readonly<ContentKnowledgeApi & ContentRealmApi & ContentReviewApi & ContentReviewChangeApi & CommunitySpaceApi>;
export {};
