import type { ReplayEntry } from './fixtures.ts';

export const entries: ReplayEntry[] = [];

export const area = "editorial";
export const moduleOwners = ["work", "content-publication", "editorial-review", "contribution", "post"];
export const replayEntries = entries;
export const coveredOperations = replayEntries.map(entry => entry.operation);
export const uncoveredOperations: string[] = [
  "POST /v1/content-edits",
  "POST /v1/content-search-eligibility",
  "POST /v1/content-publications",
  "POST /v1/content-comments",
  "POST /v1/content-drafts",
  "POST /v1/contributions",
  "POST /v1/contribution-edits",
  "POST /v1/contribution-publications",
  "POST /v1/editorial/proposals/{}/reversal",
  "POST /v1/editorial/proposals/{}/withdrawal",
  "POST /v1/editorial/proposals/{}/decisions",
  "POST /v1/editorial/proposals/{}/reviews",
  "POST /v1/editorial/proposals/{}/revisions",
  "POST /v1/editorial/proposals",
  "POST /v1/member-reply-drafts",
  "POST /v1/posts/{}/identifications",
  "PUT /v1/realms/{}/main-versions/{}/variant-recommendation",
  "PUT /v1/me/main-versions/{}/variant-preference",
  "POST /v1/publication-rejections",
  "POST /v1/publication-selections",
  "POST /v1/work-publications",
  "POST /v1/resources/{}/derivations",
  "POST /v1/works/{}/author-credits/{}/retirements",
  "POST /v1/work-maintainer-changes",
  "PUT /v1/works/{}/metadata",
  "PUT /v1/works/{}/type",
  "POST /v1/works/{}/scalar-value"
];
