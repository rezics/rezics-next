import type { ReplayEntry } from './fixtures.ts';

export const entries: ReplayEntry[] = [];

export const area = "realms";
export const moduleOwners = ["realm-admin", "realm-profile", "realm-reply", "realm-submission", "zone"];
export const replayEntries = entries;
export const coveredOperations = replayEntries.map(entry => entry.operation);
export const uncoveredOperations: string[] = [
  "POST /v1/realms/{}/join-requests",
  "POST /v1/realms/{}/join-requests/{}/decisions",
  "POST /v1/realms/{}/join-requests/{}/withdraw",
  "PUT /v1/realms/{}/moderators/{}/public-choice",
  "PUT /v1/realms/{}/profile",
  "POST /v1/realm-reply-placements",
  "POST /v1/realm-reply-reviews",
  "POST /v1/realm-replies",
  "POST /v1/realms/{}/submissions/{}/withdrawals",
  "POST /v1/realms/{}/submissions/{}/decisions",
  "POST /v1/realms/{}/submissions",
  "POST /v1/zones/{}/recoveries",
  "POST /v1/zones/{}/realm-attachment-withdrawals",
  "POST /v1/zones/{}/retirements",
  "POST /v1/zones/{}/site-publications",
  "PUT /v1/zones/{}/configuration"
];
