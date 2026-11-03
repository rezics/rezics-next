import type { PoolClient } from 'pg';
import type { MalRow } from './list-import-mal-parser.ts';
import { normalizePersonalLabelName } from './label-store.ts';
import {
  MAL_LABEL_LIMITS,
  malDigest,
  malTagEvidence,
  type MalLabelSelection,
  type MalLabelReview,
  type MalReviewedLabel,
} from './list-import-mal-tags.ts';
import { ProblemError } from '../http/problem.ts';

/** Review uses addressed native ID/name probes. It neither creates labels nor assigns them. */
export async function reviewMalLabels(
  client: Pick<PoolClient, 'query'>,
  owner: { route: number; accountId: string },
  row: MalRow,
  selected: MalLabelSelection[],
): Promise<MalLabelReview> {
  if (
    selected.length > MAL_LABEL_LIMITS.values ||
    Buffer.byteLength(JSON.stringify(selected)) > MAL_LABEL_LIMITS.selectionBytes ||
    selected.filter((s) => 'name' in s.target).length > MAL_LABEL_LIMITS.newLabels ||
    new Set(selected.map((s) => s.value)).size !== selected.length
  )
    throw new ProblemError('invalid_request');
  const evidence = malTagEvidence(row),
    selections: MalReviewedLabel[] = [];
  const values = new Map<string, MalReviewedLabel>();
  const targets = new Set<string>();
  for (const selection of selected) {
    const source = evidence.values[selection.value];
    const item: MalReviewedLabel = {
      value: selection.value,
      sourceValue: source?.value ?? null,
      target: null,
      status: 'unsupported',
      reason: evidence.reason ?? 'no-supported-source-value',
    };
    selections.push(item);
    if (evidence.kind !== 'supported' || !source) continue;
    const target = selection.target;
    if ('name' in target) {
      try {
        item.target = { name: normalizePersonalLabelName(target.name) };
      } catch {
        item.status = 'invalid';
        item.reason = 'invalid-native-name';
        continue;
      }
      const collision = await client.query<{ label_id: string }>(
        `SELECT label_id FROM library.personal_label
         WHERE route=$1 AND account_id=$2 AND normalized_name=$3 AND deleted_at IS NULL`,
        [owner.route, owner.accountId, item.target.name],
      );
      if (collision.rows.length) {
        item.status = 'collision';
        item.reason = 'choose-existing-label';
        continue;
      }
    } else {
      const current = await client.query<{ revision: number }>(
        `SELECT revision FROM library.personal_label
         WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL`,
        [owner.route, owner.accountId, target.labelId],
      );
      item.target = { labelId: target.labelId, revision: target.revision };
      if (current.rows[0]?.revision !== target.revision) {
        item.status = 'unavailable';
        item.reason = 'refresh-label';
        continue;
      }
    }
    const prior = values.get(source.value);
    if (prior && malDigest(prior.target) !== malDigest(item.target)) {
      item.status = 'invalid';
      item.reason = 'duplicate-source-has-different-target';
      continue;
    }
    const identity = malDigest(item.target);
    item.status = prior || targets.has(identity) ? 'duplicate' : 'ready';
    item.reason = prior ? 'duplicate-source-value' : targets.has(identity) ? 'duplicate-target' : null;
    values.set(source.value, item);
    targets.add(identity);
  }
  return { evidence, sourceDigest: malDigest(row), selections, selectionDigest: malDigest(selections) };
}
