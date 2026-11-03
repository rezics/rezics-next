import * as v from 'valibot';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import type { OwnClassificationsPage } from './types';

// Browser-safe projection of the source schema. Validation supplies no reader or command authority.
const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
const text = (maximum: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(maximum));
const revision = v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/));
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const summary = v.strictObject({ id, type: text(256), label: v.nullable(text(2000)), href: text(128) });
const association = v.strictObject({
  subjectId: id,
  associationId: id,
  slotId: id,
  property: text(256),
  targetId: id,
  contextId: v.literal(PAGE_GLOBAL_CONTEXT),
  origin: v.literal('global'),
  release: text(128),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  bindingHash: digest,
  statementDigest: digest,
  qualifiersDigest: digest,
});
const own = v.strictObject({
  assessment: v.picklist(['support', 'oppose']),
  falsePositive: v.boolean(),
  revision,
  pending: v.picklist(['current', 'pending', 'unknown']),
});
const advice = v.nullable(text(256));
const actions = v.strictObject({
  state: v.picklist(['editable', 'read-only', 'withdraw-only', 'withheld']),
  readback: advice,
  set: advice,
  clear: advice,
});
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const aggregateAddress = { associationId: id, pending: v.literal('unknown') };
const aggregate = v.variant('state', [
  v.strictObject({ ...aggregateAddress, state: v.literal('suppressed') }),
  v.strictObject({
    ...aggregateAddress,
    state: v.literal('published'),
    supportCount: count,
    opposeCount: count,
    falsePositiveCount: count,
    supportFraction: v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
    asOf: v.pipe(v.string(), v.isoTimestamp()),
    generation: revision,
  }),
]);
const row = { subjectId: id, associationId: id, own, actions };
const pageSchema = v.strictObject({
  viewer: v.strictObject({ accountId: id }),
  inventory: v.strictObject({
    kind: v.literal('current-retained'),
    complete: v.literal(false),
    generation: v.nullable(revision),
    cleanup: v.picklist(['not-started', 'pending', 'settled']),
  }),
  items: v.pipe(
    v.array(
      v.variant('state', [
        v.strictObject({
          ...row,
          state: v.literal('available'),
          subject: summary,
          target: summary,
          association,
          aggregate: v.nullable(aggregate),
        }),
        v.strictObject({
          ...row,
          state: v.literal('withheld'),
          subject: v.null(),
          target: v.null(),
          association: v.null(),
          aggregate: v.null(),
        }),
      ]),
    ),
    v.maxLength(21),
  ),
  traversal: v.picklist(['more', 'complete']),
  next: v.nullable(text(4096)),
});

/** Reject the entire page before any private context reaches presentation; never repair hostile input. */
export function nativeClassificationsPage(value: unknown): OwnClassificationsPage {
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    throw new Error('Invalid classification frontier');
  }
  if (bytes > 1_048_576) throw new Error('Invalid classification frontier');
  if (!v.is(pageSchema, value)) throw new Error('Invalid classification page');
  return value;
}
