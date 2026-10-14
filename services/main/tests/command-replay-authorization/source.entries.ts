import { entries as related0 } from './source-native.entries.ts';
import type { ReplayEntry } from './fixtures.ts';

export const entries: ReplayEntry[] = [];

export const area = "source";
export const moduleOwners = ["source", "catalogue-intake"];
export const replayEntries = [...entries, ...related0];
export const coveredOperations = replayEntries.map(entry => entry.operation);
export const uncoveredOperations: string[] = [
  "POST /v1/works/{}/catalogue-verifications",
  "POST /v1/works/{}/native-children/{}/retirements",
  "POST /v1/works/{}/fields/synopsis/control"
];
