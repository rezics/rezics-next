import type { PublicFilterDependencyKey } from '../semantic/index.ts';
import type { PublicFilterConsumerCaptureInput } from './public-filter-consumer-contract.ts';
import type { compileFilter } from './filter.ts';

/** One dependency closure for the canonical compiler and the native Source binding. */
export function publicFilterCaptureDependencies(
  capture: Pick<PublicFilterConsumerCaptureInput, 'sort' | 'text' | 'overflowProperties'>,
  leaves: ReturnType<typeof compileFilter>['leaves'],
): PublicFilterDependencyKey[] {
  const properties = new Set(
    leaves.flatMap((leaf) =>
      leaf.facet === 'statement'
        ? [leaf.property, ...(leaf.qualifiers?.map((qualifier) => qualifier.property) ?? [])]
        : [],
    ),
  );
  for (const property of capture.overflowProperties ?? []) properties.add(property);
  const orders = new Set<PublicFilterConsumerCaptureInput['sort']>(['id', capture.sort]);
  if (capture.text !== undefined) {
    orders.add('relevance');
    orders.add('name');
  }
  if (capture.sort === 'collections' || capture.sort === 'rating') orders.add('name');
  return [
    { kind: 'type' },
    ...[...properties].map((property): PublicFilterDependencyKey => ({ kind: 'property', property })),
    ...[...orders].map((order): PublicFilterDependencyKey => ({ kind: 'order', order })),
  ];
}

/** Only an unfiltered ID population can enroll the complete native catalogue. */
export function validateCatalogueCoverage(input: PublicFilterConsumerCaptureInput): void {
  if (
    input.catalogueCoverage !== undefined &&
    (input.catalogueCoverage !== true ||
      input.sort !== 'id' ||
      input.filterDocument !== undefined ||
      input.text !== undefined ||
      input.after !== undefined ||
      input.overflowProperties !== undefined ||
      input.rating !== undefined)
  )
    throw new TypeError('Catalogue coverage requires an unfiltered ID population');
}
