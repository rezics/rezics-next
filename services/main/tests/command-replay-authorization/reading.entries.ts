import type { ReplayEntry } from './fixtures.ts';

export const entries: ReplayEntry[] = [];

export const area = "reading";
export const moduleOwners = ["library", "feed", "follows", "preferences", "progress", "rating", "reading-settings", "review", "session", "notification", "export"];
export const replayEntries = entries;
export const coveredOperations = replayEntries.map(entry => entry.operation);
export const uncoveredOperations: string[] = [
  "POST /v1/me/follows/batch",
  "POST /v1/follows",
  "PUT /v1/me/continue/{}/hidden",
  "POST /v1/exports",
  "PUT /v1/me/feed-watermarks/{}",
  "PUT /v1/me/mutes",
  "POST /v1/me/feed-feedback",
  "PUT /v1/me/feed-preferences",
  "POST /v1/feed/{}/vote",
  "PUT /v1/me/reading-goal",
  "PUT /v1/me/import-reviews/{}",
  "PUT /v1/works/{}/reader-status",
  "PUT /v1/me/notification-preferences",
  "POST /v1/me/watches",
  "PUT /v1/me/blocked-people",
  "PUT /v1/me/person-preferences",
  "PUT /v1/me/edition-preferences/{}",
  "PUT /v1/works/{}/progress",
  "PUT /v1/compositions/{}/occurrences/{}/progress",
  "POST /v1/global-rating-observations",
  "POST /v1/global-rating-contexts",
  "POST /v1/rating-question-presentations",
  "POST /v1/rating-contexts/{}/policy-revisions",
  "POST /v1/rating-contexts",
  "POST /v1/rating-observations",
  "PUT /v1/reader/settings",
  "PUT /v1/reviews/{}/helpful",
  "DELETE /v1/reviews/{}",
  "POST /v1/reviews",
  "PATCH /v1/me/sessions/{}",
  "POST /v1/me/sessions",
  "POST /v1/me/library-loans/{}/return",
  "POST /v1/me/library-loans/{}/extend",
  "POST /v1/me/library-loans",
  "DELETE /v1/me/library-copies/{}",
  "PATCH /v1/me/library-copies/{}",
  "POST /v1/me/library-copies"
];
