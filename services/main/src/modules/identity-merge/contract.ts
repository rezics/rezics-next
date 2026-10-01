import { createHash } from 'node:crypto';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { EditorialInvalid, canonicalCandidate, type Json } from '../editorial-review/contract.ts';
import { targetRef, targetRevision } from '../target/contract.ts';
import { MAX_WORK_REDIRECT_HOPS } from '../address/contract.ts';

/** Per request/run ceilings, never a limit on the inventory of a Resource.
 * Planning seeks one owner's indexed source incidence; item delivery uses one
 * owner CAS/receipt. Native owner cost must be declared by each handler. */
export const MERGE_COST = { page: 32, itemsPerRun: 32, owners: 32, itemBytes: 65_536,
  taskBytes: 1_048_576, evidence: 32, redirectHops: MAX_WORK_REDIRECT_HOPS,
  deadlineMs: 10_000, headerValues: 32, headerBytes: 262_144 } as const;
const closed = { additionalProperties: false } as const;
const pin = t.Object({ resource: targetRef, revision: targetRevision }, closed);
const evidence = t.Object({ resource: t.String({ minLength: 1, maxLength: 512 }),
  revision: t.String({ minLength: 1, maxLength: 512 }),
  locator: t.Nullable(t.String({ maxLength: 4000 })) }, closed);
export const mergePlan = t.Object({ operation: t.Literal('merge'), source: pin, survivor: pin,
  evidence: t.Array(evidence, { minItems: 1, maxItems: MERGE_COST.evidence }) }, closed);
export const unmergePlan = t.Object({ operation: t.Literal('unmerge'), source: pin, survivor: pin,
  /** Retained task, not arbitrary owner snapshots supplied by the client. */
  original: t.String({ pattern: '^editorial:[0-9a-f-]{36}:[1-9][0-9]*$' }),
  evidence: t.Array(evidence, { minItems: 1, maxItems: MERGE_COST.evidence }) }, closed);
export type MergePlan = Static<typeof mergePlan>;
export type UnmergePlan = Static<typeof unmergePlan>;
export type IdentityPlan = MergePlan | UnmergePlan;
export type IdentityPin = MergePlan['source'];
export class InvalidMerge extends EditorialInvalid {}
export class MergeUnavailable extends Error {}
export class MergeConflict extends Error {}
export class MergePending extends Error {}

export function checkedPlan(raw: unknown): IdentityPlan {
  if (!Value.Check(mergePlan, raw) && !Value.Check(unmergePlan, raw)) {
    throw new InvalidMerge('An evidenced merge or compensating unmerge is required; split is not admitted');
  }
  if (raw.source.resource === raw.survivor.resource) throw new InvalidMerge('A Resource cannot merge into itself');
  return canonicalCandidate(raw).candidate as unknown as IdentityPlan;
}
export const mergeDigest = (value: unknown) => canonicalCandidate(value).digest;
export const itemCommandKey = (task: string, owner: string, item: string) =>
  `merge:${createHash('sha256').update(JSON.stringify([task, owner, item])).digest('hex')}`;

export interface IdentityHeader {
  resource: string; revision: string; grain: string;
  titles: Array<{ language: string; value: string }>;
  creators: Array<{ resource: string; names: Array<{ language: string; value: string }> }>;
  dates: Json[]; identifiers: Json[];
}
export interface OwnerCount {
  owner: string;
  /** A capped probe reports a lower bound, never a false complete count. */
  count: number; complete: boolean;
}
export interface MergePreview { source: IdentityHeader; survivor: IdentityHeader; owners: OwnerCount[] }

export interface MergeTask {
  key: string; application: string; candidateDigest: string;
  plan: IdentityPlan; dataEpoch: string;
  /** Freeze handler versions; deploying another implementation cannot silently
   * change a half-delivered task's meaning. */
  handlers: Array<{ owner: string; version: string }>;
}
export interface MergeItem {
  key: string; expectedHead: string | null;
  /** Private owner prestate, not a user-visible task status field. */
  before: Json;
}
export type ItemOutcome = {
  outcome: 'moved' | 'history' | 'retained' | 'ambiguous';
  /** Owner-native durable receipt with this exact itemCommandKey. */
  receipt: string; commandKey: string; afterHead: string | null; after: Json;
};
export interface RecordedItem extends MergeItem { owner: string; result: ItemOutcome | null }
export interface OwnerPage { items: MergeItem[]; next: string | null }
export interface OwnerCheckpoint { after: string | null; exhausted: boolean; page: number }
export interface TaskCompletion { receipt: string; commandKey: string; result: Json }
export interface MergeHandler<Dependencies = unknown> {
  owner: string; version: string;
  /** SQL person-state coverage is exact. Authority and immutable provenance
   * exclusions belong to the reference inventory, never a wildcard handler. */
  references: string[];
  cost: { page: number; callsPerItem: number; bytesPerItem: number };
  preview(plan: IdentityPlan, dependencies: Dependencies): Promise<OwnerCount>;
  /** Indexed, bytewise keyset order. Ordinary Work writes resolve the first identity link. */
  plan(task: MergeTask, after: string | null, limit: number, dependencies: Dependencies): Promise<OwnerPage>;
  /** Resolve the key's receipt BEFORE checking the head. Receipt and effect
   * must commit together in the owner; retry after a lost response is one effect. */
  apply(task: MergeTask, item: MergeItem, commandKey: string, dependencies: Dependencies): Promise<ItemOutcome>;
  /** Compare the exact post-merge owner head in the compensation commit. Later
   * writes return a durable ambiguous outcome without overwriting those writes. */
  compensate(task: MergeTask, original: RecordedItem & { result: ItemOutcome },
    commandKey: string, dependencies: Dependencies): Promise<ItemOutcome>;
}
export interface MergeHandlerModule<Dependencies = unknown> {
  owner: string; create(dependencies: Dependencies): MergeHandler<Dependencies>;
}

export function checkedItem(item: MergeItem): MergeItem {
  if (!item || typeof item.key !== 'string' || !item.key.length || item.key.length > 512
    || /[\u0000-\u001f\u007f]/u.test(item.key)
    || Buffer.from(item.key).toString('utf8') !== item.key
    || item.expectedHead !== null && (typeof item.expectedHead !== 'string'
      || !item.expectedHead.length || item.expectedHead.length > 512)) throw new InvalidMerge('Invalid owner item');
  // RecordedItem adds a separately bounded receipt. Validate the snapshot
  // budget independently; compensation must support two full-size records.
  canonicalCandidate({ key: item.key, expectedHead: item.expectedHead, before: item.before },
    { bytes: MERGE_COST.itemBytes, depth: 32 });
  return item;
}
export function checkedOutcome(result: ItemOutcome, commandKey: string): ItemOutcome {
  if (!result || !['moved', 'history', 'retained', 'ambiguous'].includes(result.outcome)
    || result.commandKey !== commandKey || typeof result.receipt !== 'string'
    || !result.receipt.length || result.receipt.length > 512
    || result.afterHead !== null && (typeof result.afterHead !== 'string'
      || !result.afterHead.length || result.afterHead.length > 512)
    || result.outcome === 'moved' && result.afterHead === null) throw new InvalidMerge('Owner outcome lacks an exact receipt');
  canonicalCandidate(result, { bytes: MERGE_COST.itemBytes, depth: 32 });
  return result;
}
