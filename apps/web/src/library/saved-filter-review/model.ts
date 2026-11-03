import { facetProperties, type FilterDocument, type FilterRange, type FilterRelease } from '@rezics/filter';
import type { ConditionMetadata } from '../../search/condition-editor-model';
import type { ReviewRelease } from './read';

export type CurrentFieldState = 'available' | 'missing-label' | 'removed' | 'changed' | 'unavailable';
export type ReviewValue = { exact: string; acceptedLabel?: string; currentTypeLabel?: string };
export type ReviewQualifier = {
  property: string;
  acceptedLabel?: string;
  currentLabel?: string;
  currentState: CurrentFieldState;
  values: ReviewValue[];
};

export type ReviewOperand = {
  role: 'property' | 'type' | 'owner' | 'saved';
  path: string;
  operation: 'in' | 'range' | 'condition' | 'reference';
  fieldId?: string;
  acceptedLabel?: string;
  currentLabel?: string;
  currentState: CurrentFieldState;
  datatype?: string;
  values?: ReviewValue[];
  range?: FilterRange;
  qualifiers?: ReviewQualifier[];
  exact?: string;
};

export type ReviewTree =
  | { kind: 'operand'; value: ReviewOperand }
  | { kind: 'group'; path: string; operator: 'and' | 'or' | 'not' | 'saved'; reference?: string; children: ReviewTree[] };

function label(labels: Record<string, string> | undefined, locale: string): string | undefined {
  const language = locale.split('-')[0]!;
  const candidates = [labels?.[locale], labels?.[language], labels?.en];
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim();
}

type Definition = { labels?: Record<string, string>; datatype?: string };

function fieldMeaning(
  fieldId: string,
  role: 'property' | 'type',
  accepted: ReviewRelease,
  current: ReviewRelease,
  locale: string,
): Pick<ReviewOperand, 'acceptedLabel' | 'currentLabel' | 'currentState' | 'datatype'> {
  const acceptedDefinition: Definition | undefined =
    role === 'type' ? accepted.metadata?.types[fieldId] : accepted.metadata?.properties[fieldId];
  const currentDefinition: Definition | undefined =
    role === 'type' ? current.metadata?.types[fieldId] : current.metadata?.properties[fieldId];
  const acceptedLabel = label(acceptedDefinition?.labels, locale);
  const currentLabel = label(currentDefinition?.labels, locale);
  let currentState: CurrentFieldState;
  if (current.state !== 'ready' || !current.metadata) currentState = 'unavailable';
  else if (!currentDefinition) currentState = 'removed';
  else if (
    role === 'property' &&
    acceptedDefinition?.datatype &&
    currentDefinition.datatype &&
    acceptedDefinition.datatype !== currentDefinition.datatype
  )
    currentState = 'changed';
  else if (!currentLabel) currentState = 'missing-label';
  else currentState = 'available';
  return {
    ...(acceptedLabel ? { acceptedLabel } : {}),
    ...(currentLabel ? { currentLabel } : {}),
    currentState,
    ...(acceptedDefinition?.datatype ? { datatype: acceptedDefinition.datatype } : {}),
  };
}

function valueViews(values: readonly string[], metadata: ConditionMetadata | undefined, current: ReviewRelease, locale: string) {
  return values.map((exact) => {
    const acceptedLabel = label(metadata?.types[exact]?.labels, locale);
    const currentTypeLabel = label(current.metadata?.types[exact]?.labels, locale);
    return {
      exact,
      ...(acceptedLabel ? { acceptedLabel } : {}),
      ...(currentTypeLabel ? { currentTypeLabel } : {}),
    };
  });
}

function savedDefinition(metadata: ConditionMetadata | undefined, id: string): FilterDocument | undefined {
  return metadata?.filters?.[id]?.filter;
}

function typeState(values: ReviewValue[], current: ReviewRelease, locale: string): CurrentFieldState {
  if (current.state !== 'ready' || !current.metadata) return 'unavailable';
  if (values.some(({ exact }) => !current.metadata!.types[exact])) return 'removed';
  if (values.some(({ exact }) => !label(current.metadata!.types[exact]?.labels, locale))) return 'missing-label';
  return 'available';
}

/** Keep the saved AST's grouping and exact operand order visible, including unreleased and nested saved terms. */
export function savedFilterReviewTree(
  filter: FilterDocument,
  accepted: ReviewRelease,
  current: ReviewRelease,
  locale: string,
): ReviewTree {
  const expand = (node: FilterDocument, path: string, stack: readonly string[]): ReviewTree => {
    if ('and' in node)
      return {
        kind: 'group',
        path,
        operator: 'and',
        children: node.and.map((child, index) => expand(child, path + '/and/' + index, stack)),
      };
    if ('or' in node)
      return {
        kind: 'group',
        path,
        operator: 'or',
        children: node.or.map((child, index) => expand(child, path + '/or/' + index, stack)),
      };
    if ('not' in node)
      return {
        kind: 'group',
        path,
        operator: 'not',
        children: [expand(node.not, path + '/not', stack)],
      };
    if ('saved' in node) {
      const definition = savedDefinition(accepted.metadata, node.saved);
      if (definition && !stack.includes(node.saved) && stack.length < 16)
        return {
          kind: 'group',
          path,
          operator: 'saved',
          reference: node.saved,
          children: [expand(definition, path + '/saved/' + node.saved, [...stack, node.saved])],
        };
      return {
        kind: 'operand',
        value: {
          role: 'saved',
          path,
          operation: 'reference',
          fieldId: node.saved,
          currentState: 'unavailable',
        },
      };
    }
    if ('type' in node) {
      const values = valueViews(node.type.in, accepted.metadata, current, locale);
      return {
        kind: 'operand',
        value: { role: 'type', path, operation: 'in', fieldId: 'type', currentState: typeState(values, current, locale), values },
      };
    }
    if ('statement' in node) {
      const statement = node.statement;
      return {
        kind: 'operand',
        value: {
          role: 'property',
          path,
          operation: 'in' in statement ? 'in' : 'range',
          fieldId: statement.property,
          ...fieldMeaning(statement.property, 'property', accepted, current, locale),
          ...('in' in statement ? { values: statement.in.map((exact) => ({ exact })) } : { range: statement.range }),
          ...(statement.qualifiers?.length
            ? {
                qualifiers: statement.qualifiers.map((qualifier) => ({
                  property: qualifier.property,
                  ...fieldMeaning(qualifier.property, 'property', accepted, current, locale),
                  values: qualifier.in.map((exact) => ({ exact })),
                })),
              }
            : {}),
        },
      };
    }
    if ('owner' in node)
      return {
        kind: 'operand',
        value: { role: 'owner', path, operation: 'condition', currentState: 'available', exact: JSON.stringify(node) },
      };
    return {
      kind: 'operand',
      value: { role: 'saved', path, operation: 'reference', currentState: 'unavailable', exact: JSON.stringify(node) },
    };
  };
  return expand(filter, '', []);
}

function positiveTypes(filter: FilterDocument, metadata: ConditionMetadata | undefined, stack: readonly string[]): string[] {
  if ('type' in filter) return [...filter.type.in];
  if ('saved' in filter) {
    const expanded = savedDefinition(metadata, filter.saved);
    return expanded && !stack.includes(filter.saved)
      ? positiveTypes(expanded, metadata, [...stack, filter.saved])
      : [];
  }
  if ('and' in filter)
    return filter.and.flatMap((child) =>
      'type' in child || 'and' in child || 'saved' in child ? positiveTypes(child, metadata, stack) : [],
    );
  return [];
}

/** Search value labels need one exact positive Type and current Collection scope; never guess a Global fallback. */
export function savedFilterFacetType(filter: FilterDocument, accepted: ConditionMetadata | undefined): string | undefined {
  const values = [...new Set(positiveTypes(filter, accepted, []))];
  return values.length === 1 ? values[0] : undefined;
}

function collectValueProperties(
  filter: FilterDocument,
  accepted: ConditionMetadata | undefined,
  output: Set<string>,
  stack: readonly string[],
) {
  if ('and' in filter || 'or' in filter) {
    for (const child of 'and' in filter ? filter.and : filter.or)
      collectValueProperties(child, accepted, output, stack);
    return;
  }
  if ('not' in filter) {
    collectValueProperties(filter.not, accepted, output, stack);
    return;
  }
  if ('saved' in filter) {
    const expanded = savedDefinition(accepted, filter.saved);
    if (expanded && !stack.includes(filter.saved))
      collectValueProperties(expanded, accepted, output, [...stack, filter.saved]);
    return;
  }
  if ('statement' in filter && 'in' in filter.statement) {
    output.add(filter.statement.property);
    for (const qualifier of filter.statement.qualifiers ?? []) output.add(qualifier.property);
  }
}

/** Batch current item/code fields by Search's eight-property wire limit, not once per selected operand. */
export function savedFilterFacetBatches(
  filter: FilterDocument,
  accepted: ConditionMetadata | undefined,
  current: ReviewRelease,
): string[][] {
  if (current.state !== 'ready' || !current.metadata) return [];
  const type = savedFilterFacetType(filter, accepted);
  if (!type || !current.metadata.types[type]) return [];
  const roster = new Set(facetProperties(current.metadata as FilterRelease, [type]));
  const properties = new Set<string>();
  collectValueProperties(filter, accepted, properties, []);
  const requested = [...properties].filter((property) => {
    const definition = current.metadata!.properties[property];
    return (
      roster.has(property) &&
      (definition?.datatype === 'wikibase-item' ||
        (definition?.datatype === 'string' && Boolean(definition.value?.pattern)))
    );
  });
  const batches: string[][] = [];
  for (let index = 0; index < requested.length; index += 8) batches.push(requested.slice(index, index + 8));
  return batches;
}

export function disclosedValueLabel(
  labels: Record<string, Record<string, Record<string, string>>>,
  property: string,
  exact: string,
  locale: string,
): string | undefined {
  return label(labels[property]?.[exact], locale);
}
