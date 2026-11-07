import { isDeepStrictEqual } from 'node:util';
import { releaseDigest } from '@rezics/definitions';
import { admitFilter, walkFilter } from '@rezics/filter';
import type { PublicFilterSearchBindingPort, SourceBindingCaptureInput } from '../semantic/index.ts';
import type { PublicFilterConsumerCaptureInput } from './public-filter-consumer-contract.ts';
import type { PublicFilterDependencyKey, PublicFilterProjectionMeaning } from '../semantic/index.ts';
import { publicFilterCatalogue } from './discovery-catalogue.ts';
import { compileDiscoveryConsumerCapture } from './discovery-filter.ts';
import { compileFilter } from './filter.ts';
import {
  decodePublicFilterNativeState,
  encodePublicFilterNativeState,
  readGenerationPublicationCustody,
  readPublicFilterConsumerCustody,
  readPublicFilterRepairSettlement,
  withPublicFilterRepairAllowance,
} from './public-filter-custody.ts';
import { publicFilterCoverageStart } from './public-filter-coverage-page.ts';
import { validateSearchAfter } from './query-payload.ts';
import { validatePublicSuggestionInput } from './public-suggestion-input.ts';
import { compileText } from './text.ts';

function captureKeys(meaning: PublicFilterProjectionMeaning, input: SourceBindingCaptureInput) {
  if (meaning.digest !== releaseDigest(meaning.release) || !meaning.release.types[meaning.type])
    throw new TypeError('Unknown projection meaning');
  if ('purpose' in input) return suggestionKeys(input);
  if ('representation' in input) return discoveryKeys(meaning, input);
  return searchKeys(meaning, input as PublicFilterConsumerCaptureInput);
}

function searchKeys(
  meaning: PublicFilterProjectionMeaning,
  input: PublicFilterConsumerCaptureInput,
): PublicFilterDependencyKey[] {
  if (
    !Object.hasOwn(input, 'filterDocument') ||
    !Object.hasOwn(input, 'text') ||
    !Number.isInteger(input.size) ||
    input.size < 1 ||
    input.size > 200 ||
    !['id', 'name', 'relevance', 'collections', 'rating'].includes(input.sort)
  )
    throw new TypeError('Complete capture input is required');
  if (input.sort !== 'rating') validateSearchAfter(input);
  if (input.filterDocument !== undefined) {
    for (const node of walkFilter(input.filterDocument))
      if ('owner' in node || 'saved' in node) throw new TypeError('Only expanded public filters may bind');
    const admitted = admitFilter(input.filterDocument, meaning.release, { inverse: true });
    if (!isDeepStrictEqual(admitted, input.filterDocument)) throw new TypeError('Capture must already be admitted');
  }
  const filter =
    input.filterDocument === undefined
      ? undefined
      : compileFilter(input.filterDocument, { prefix: 'f', relationOverflow: true });
  const text = input.text === undefined ? undefined : compileText(input.text, { field: 'search_text', prefix: 't' });
  const overflowProperties = filter
    ? [...new Set(filter.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : [])))]
    : undefined;
  for (const [key, value] of Object.entries({
    filter: filter?.query,
    query: text?.query,
    boost: text?.leaves
      .filter((leaf) => !leaf.negated)
      .map((leaf) => leaf.value)
      .join(' '),
  })) {
    if (Object.hasOwn(input, key) && !isDeepStrictEqual(input[key as keyof typeof input], value))
      throw new TypeError('Compiled capture differs from its retained input');
  }
  if (Object.hasOwn(input, 'overflowProperties')) {
    const actual = input.overflowProperties;
    const required = overflowProperties ?? [];
    if (
      !Array.isArray(actual) ||
      actual.some((property) => typeof property !== 'string') ||
      required.some((property) => !actual.includes(property))
    )
      throw new TypeError('Compiled capture differs from its retained input');
  }
  const keys: PublicFilterDependencyKey[] = [
    { kind: 'order', order: input.sort },
    { kind: 'type' },
    { kind: 'field', field: 'id' },
  ];
  for (const leaf of filter?.leaves ?? []) {
    if (leaf.facet === 'type') keys.push({ kind: 'type' });
    else {
      keys.push({ kind: 'property', property: leaf.property });
      for (const qualifier of leaf.qualifiers ?? []) keys.push({ kind: 'property', property: qualifier.property });
    }
  }
  if (Array.isArray(input.overflowProperties))
    for (const property of input.overflowProperties) keys.push({ kind: 'property', property });
  if (text)
    keys.push(...(['labels', 'aliases', 'descriptions'] as const).map((field) => ({ kind: 'field' as const, field })));
  if (['name', 'collections', 'rating'].includes(input.sort))
    keys.push({ kind: 'field', field: 'name_sort' }, { kind: 'field', field: 'labels' });
  if (input.sort === 'collections') keys.push({ kind: 'function', input: 'public_collection_count' });
  if (input.sort === 'rating') keys.push({ kind: 'function', input: 'public_rating' });
  return keys.filter((key, index) => keys.findIndex((other) => isDeepStrictEqual(key, other)) === index);
}

function suggestionKeys(
  input: Extract<SourceBindingCaptureInput, { purpose: 'suggest' }>,
): PublicFilterDependencyKey[] {
  validatePublicSuggestionInput(input);
  return [
    { kind: 'type' },
    { kind: 'field', field: 'id' },
    { kind: 'field', field: 'labels' },
    { kind: 'field', field: 'aliases' },
    { kind: 'field', field: 'name_sort' },
    { kind: 'order', order: 'name' },
    { kind: 'order', order: 'id' },
  ];
}

function discoveryKeys(
  meaning: PublicFilterProjectionMeaning,
  input: Extract<SourceBindingCaptureInput, { representation: string }>,
): PublicFilterDependencyKey[] {
  const keys = [
    ...compileDiscoveryConsumerCapture(input, meaning, undefined).dependencyKeys,
    { kind: 'field' as const, field: 'id' as const },
    ...(input.sort === 'name'
      ? [
          { kind: 'field' as const, field: 'name_sort' as const },
          { kind: 'field' as const, field: 'labels' as const },
          { kind: 'field' as const, field: 'aliases' as const },
        ]
      : []),
  ];
  return keys.filter((key, index) => keys.findIndex((other) => isDeepStrictEqual(key, other)) === index);
}

/** Search-owned planning and custody producers consumed by the Semantic application. */
export function createSearchSourceBindingAdapter(): PublicFilterSearchBindingPort {
  return Object.freeze({
    deriveDependencyKeys: captureKeys,
    catalogue: publicFilterCatalogue,
    encodeConsumer: encodePublicFilterNativeState,
    encodeState: encodePublicFilterNativeState,
    decodeState: decodePublicFilterNativeState,
    coverageStart: publicFilterCoverageStart,
    readConsumerCustody: readPublicFilterConsumerCustody,
    readGenerationPublicationCustody,
    readRepairSettlement: readPublicFilterRepairSettlement,
    withRepairAllowance: withPublicFilterRepairAllowance,
  });
}
