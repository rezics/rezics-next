import type { ReplayEntry } from './fixtures.ts';

export const entries: ReplayEntry[] = [];

export const area = "structure";
export const moduleOwners = ["structure", "collection", "space", "realization", "release", "projection"];
export const replayEntries = entries;
export const coveredOperations = replayEntries.map(entry => entry.operation);
export const uncoveredOperations: string[] = [
  "POST /v1/collections/{}/display-groups/{}/moves",
  "POST /v1/collections/{}/changes",
  "PUT /v1/collections/{}/name",
  "POST /v1/collections",
  "POST /v1/compositions/{}/restorations",
  "POST /v1/compositions/{}/changes",
  "POST /v1/compositions",
  "POST /v1/projections",
  "PUT /v1/works/{}/realizations/{}",
  "POST /v1/recipes/{}/imports",
  "PUT /v1/works/{}/releases/{}",
  "POST /v1/spaces",
  "POST /v1/works/{}/chapters",
  "DELETE /v1/zones/{}/mounts/{}",
  "POST /v1/zones/{}/mounts",
  "POST /v1/zones"
];
