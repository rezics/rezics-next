import * as v from 'valibot';
import { isCalendarDate } from '@rezics/filter';
import { parseListPresentation } from '@rezics/ui/cover';
import type { Fact } from '../../../search/results';

const text = v.pipe(v.string(), v.maxLength(320));
const property = v.pipe(v.string(), v.minLength(1), v.maxLength(160));
const localized = v.pipe(
  v.record(v.string(), text),
  v.check((value) => Object.keys(value).length <= 8),
);
const id = v.pipe(v.string(), v.uuid());
const source = v.strictObject({
  label: localized,
  observation: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
});
const destination = v.strictObject({ id });
const fact: v.GenericSchema<Fact> = v.variant('kind', [
  v.strictObject({ kind: v.literal('item'), id, labels: localized }),
  v.pipe(
    v.strictObject({
      kind: v.literal('time'),
      year: v.pipe(v.number(), v.integer()),
      month: v.exactOptional(v.pipe(v.number(), v.integer())),
      day: v.exactOptional(v.pipe(v.number(), v.integer())),
    }),
    v.check((value) => isCalendarDate(value)),
  ),
  v.strictObject({ kind: v.literal('quantity'), amount: v.pipe(v.number(), v.finite()), unit: text }),
  v.strictObject({ kind: v.literal('code'), value: text }),
]);
const facts = v.pipe(
  v.record(property, v.pipe(v.array(fact), v.maxLength(3))),
  v.check((value) => Object.keys(value).length <= 4),
);
const common = {
  version: v.literal(1),
  subject: id,
  target: v.nullable(destination),
  observation: source.entries.observation,
};
const context = v.variant('state', [
  ...(['unknown', 'withheld', 'absent', 'unavailable'] as const).map((state) =>
    v.strictObject({ ...common, state: v.literal(state) }),
  ),
  v.strictObject({
    ...common,
    state: v.literal('ready'),
    medium: localized,
    creators: v.pipe(
      v.array(
        v.strictObject({
          property,
          direction: v.literal('subject-to-creator'),
          role: localized,
          name: localized,
          target: v.nullable(destination),
          qualifiers: v.pipe(v.array(v.strictObject({ label: localized, value: localized })), v.maxLength(3)),
          source,
        }),
      ),
      v.maxLength(3),
    ),
    facts: v.pipe(
      v.array(
        v.strictObject({
          property,
          label: localized,
          value: fact,
          source,
        }),
      ),
      v.maxLength(4),
    ),
    statistic: v.nullable(
      v.pipe(
        v.strictObject({
          measure: localized,
          value: v.pipe(v.number(), v.finite()),
          scale: v.nullable(
            v.strictObject({ min: v.pipe(v.number(), v.finite()), max: v.pipe(v.number(), v.finite()) }),
          ),
          count: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER))),
          source,
        }),
        v.check(
          (value) =>
            value.scale === null ||
            (value.scale.min < value.scale.max && value.value >= value.scale.min && value.value <= value.scale.max),
        ),
      ),
    ),
    more: v.boolean(),
  }),
]);

/** Reserved page-composition seam, not a claim that the native producer already publishes it. */
export type CatalogueContext = v.InferOutput<typeof context>;
export type CatalogueRowContext = ReturnType<typeof catalogueRowContext>;

/** Limit visible text without losing language, property, date precision or source identity. */
export function catalogueText(value: string): string {
  const characters = Array.from(value.slice(0, 322));
  return characters.length > 160 ? `${characters.slice(0, 159).join('')}…` : value;
}

/** Only the current native row may supply its context. There is no lookup, cache or per-target hydration. */
export function catalogueRowContext(row: {
  id: string;
  facts?: unknown;
  listPresentation?: unknown;
  catalogueContext?: unknown;
}) {
  const admittedFacts = v.safeParse(facts, row.facts);
  const admitted = v.safeParse(context, row.catalogueContext);
  const supplied =
    admitted.success &&
    admitted.output.subject === row.id &&
    (admitted.output.target === null || admitted.output.target.id === row.id);
  const value: CatalogueContext = supplied
    ? admitted.output
    : {
        version: 1,
        subject: row.id,
        // A native Search row already discloses its ordinary destination. Invalid explicit context grants none.
        target: row.catalogueContext === undefined ? { id: row.id } : null,
        observation: 'unavailable',
        state: 'unavailable',
      };
  return {
    context: value,
    facts: row.catalogueContext === undefined && admittedFacts.success ? admittedFacts.output : undefined,
    presentation: parseListPresentation(row.listPresentation),
  };
}
