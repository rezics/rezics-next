import type { ReplayEntry } from './fixtures.ts';

export const entries: ReplayEntry[] = [];

export const area = "meaning";
export const moduleOwners = ["context", "classification", "relation", "semantic", "judgment", "suitability"];
export const replayEntries = entries;
export const coveredOperations = replayEntries.map(entry => entry.operation);
export const uncoveredOperations: string[] = [
  "POST /v1/classification-contexts",
  "POST /v1/classification-propositions",
  "POST /v1/tag-proposals",
  "POST /v1/classification-vocabulary",
  "POST /v1/statement-decisions",
  "POST /v1/statements/{}/withdrawals",
  "POST /v1/statements",
  "PUT /v1/me/context-selections",
  "POST /v1/realms/{}/context-selections",
  "POST /v1/context-definition-states",
  "POST /v1/context-definition-equivalences",
  "POST /v1/contexts/{}/preferences",
  "POST /v1/contexts/{}/state-transitions",
  "POST /v1/contexts/{}/semantic-revisions",
  "POST /v1/contexts",
  "POST /v1/context-rule-dependencies",
  "POST /v1/context-rules",
  "POST /v1/semantic/changes/bulk",
  "POST /v1/semantic/changes",
  "POST /v1/statements/{}/judgments",
  "POST /v1/concepts/{}/spoiler-hints",
  "POST /v1/relations/changes",
  "PUT /v1/suitability/{}"
];
