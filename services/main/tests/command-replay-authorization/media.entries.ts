import type { ReplayEntry } from './fixtures.ts';

export const entries: ReplayEntry[] = [];

export const area = "media";
export const moduleOwners = ["media", "resources", "recipes", "catalog"];
export const replayEntries = entries;
export const coveredOperations = replayEntries.map(entry => entry.operation);
export const uncoveredOperations: string[] = [
  "POST /v1/media/publications",
  "POST /v1/media/assets/{}/state",
  "PUT /v1/media/uploads/{}/bytes",
  "POST /v1/media/uploads",
  "POST /v1/media/uses",
  "POST /v1/media/representations/{}/inferences",
  "POST /v1/media/uses/{}/conceal",
  "POST /v1/media/representations/{}/labels",
  "POST /v1/zones/{}/campaign-art",
  "PATCH /v1/catalog/resources/{}/descriptions",
  "PUT /v1/resources/{}/avatar",
  "PUT /v1/resources/{}/showcase/trailer",
  "PUT /v1/resources/{}/showcase/art"
];
