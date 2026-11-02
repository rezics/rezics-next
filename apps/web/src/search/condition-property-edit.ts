import type { FilterDocument, FilterRange } from '@rezics/filter';
import type { ConditionMetadata } from './condition-editor-model';

type Properties = ConditionMetadata['properties'];
type PropertyDefinition = Properties[string] | undefined;

export type ConditionPropertyTransition = {
  original: FilterDocument;
  next: FilterDocument;
  requiresConfirmation: boolean;
};

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

function sameUnits(left: PropertyDefinition, right: PropertyDefinition): boolean {
  return canonical([...(left?.units ?? [])].sort()) === canonical([...(right?.units ?? [])].sort());
}

function sameValueDefinition(left: PropertyDefinition, right: PropertyDefinition): boolean {
  return (
    !!left &&
    !!right &&
    !!left.datatype &&
    left.datatype === right.datatype &&
    sameUnits(left, right) &&
    canonical(left.value) === canonical(right.value)
  );
}

function sameRangeMeaning(left: PropertyDefinition, right: PropertyDefinition, range: FilterRange): boolean {
  if (!left || !right || !left.datatype || left.datatype !== right.datatype) return false;
  if (range.unit !== undefined)
    return left.units?.includes(range.unit) === true && right.units?.includes(range.unit) === true;
  return sameUnits(left, right);
}

function hasValues(values: readonly string[] | undefined): boolean {
  return values?.some((value) => value !== '') ?? false;
}

function hasRange(range: FilterRange): boolean {
  return range.gte !== undefined || range.lte !== undefined || (range.unit !== undefined && range.unit !== '');
}

function freshOperand(definition: PropertyDefinition) {
  if (definition?.datatype === 'quantity') {
    return { range: definition.units?.[0] ? { unit: definition.units[0] } : {} };
  }
  if (definition?.datatype === 'time') return { range: {} };
  return { in: [''] };
}

export function changeStatementProperty(
  value: FilterDocument,
  nextProperty: string,
  properties: Properties,
): ConditionPropertyTransition {
  if (!('statement' in value) || value.statement.property === nextProperty) {
    return { original: value, next: value, requiresConfirmation: false };
  }

  const statement = value.statement;
  const previousDefinition = properties[statement.property];
  const nextDefinition = properties[nextProperty];
  const operands: { in?: readonly string[]; range?: FilterRange } = {};
  let requiresConfirmation = false;
  let retainedOperand = false;

  if ('in' in statement) {
    if (sameValueDefinition(previousDefinition, nextDefinition)) {
      operands.in = statement.in;
      retainedOperand = true;
    } else if (hasValues(statement.in)) {
      requiresConfirmation = true;
    }
  }

  if ('range' in statement) {
    if (sameRangeMeaning(previousDefinition, nextDefinition, statement.range)) {
      operands.range = statement.range;
      retainedOperand = true;
    } else if (hasRange(statement.range)) {
      requiresConfirmation = true;
    }
  }

  if (!retainedOperand) Object.assign(operands, freshOperand(nextDefinition));

  const qualifiers = (statement.qualifiers ?? []).filter((qualifier) => {
    const compatible =
      previousDefinition?.qualifiers?.includes(qualifier.property) === true &&
      nextDefinition?.qualifiers?.includes(qualifier.property) === true &&
      properties[qualifier.property] !== undefined;
    if (compatible) return true;
    if (hasValues(qualifier.in)) requiresConfirmation = true;
    return false;
  });

  const next: FilterDocument = {
    statement: {
      property: nextProperty,
      ...operands,
      ...(qualifiers.length ? { qualifiers } : {}),
    },
  } as FilterDocument;
  return { original: value, next, requiresConfirmation };
}

export function changeQualifierProperty(
  value: FilterDocument,
  index: number,
  nextProperty: string,
  properties: Properties,
): ConditionPropertyTransition {
  if (!('statement' in value)) return { original: value, next: value, requiresConfirmation: false };
  const qualifier = value.statement.qualifiers?.[index];
  if (!qualifier || qualifier.property === nextProperty) {
    return { original: value, next: value, requiresConfirmation: false };
  }

  const compatible = sameValueDefinition(properties[qualifier.property], properties[nextProperty]);
  const qualifiers = value.statement.qualifiers!.map((entry, at) =>
    at === index ? { property: nextProperty, in: compatible ? entry.in : [''] } : entry,
  );
  const next: FilterDocument = { statement: { ...value.statement, qualifiers } };
  return {
    original: value,
    next,
    requiresConfirmation: !compatible && hasValues(qualifier.in),
  };
}

export function resolveConditionPropertyChange(
  transition: ConditionPropertyTransition,
  confirmed: boolean,
): FilterDocument {
  return confirmed ? transition.next : transition.original;
}
