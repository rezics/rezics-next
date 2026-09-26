import { RV } from './activate.ts';

/** The complete admitted value space of the bounded MODEL02 Work property. */
export type WorkScalarValue =
  | { kind: 'integer'; lexical: '0' }
  | { kind: 'boolean'; lexical: 'false' }
  | { kind: 'string'; lexical: '' }
  | { kind: 'unknown' }
  | { kind: 'no-value' };

export const SCALAR_PREDICATE = `${RV}scalarValue`;
export const SCALAR_UNKNOWN = `${RV}ExplicitUnknown`;
export const SCALAR_NO_VALUE = `${RV}ExplicitNoValue`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export class InvalidWorkScalarValue extends Error {}

/** Absence is represented by no property in the request, manifest, and export. */
export function checkedWorkScalarValue(value: unknown): WorkScalarValue | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidWorkScalarValue('invalid Work scalar value');
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (row.kind === 'integer' && row.lexical === '0'
    || row.kind === 'boolean' && row.lexical === 'false'
    || row.kind === 'string' && row.lexical === '') {
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('lexical')) {
      throw new InvalidWorkScalarValue('invalid Work scalar lexical state');
    }
    return { kind: row.kind, lexical: row.lexical } as WorkScalarValue;
  }
  if ((row.kind === 'unknown' || row.kind === 'no-value') && keys.length === 1) {
    return { kind: row.kind } as WorkScalarValue;
  }
  throw new InvalidWorkScalarValue('unsupported Work scalar value');
}

export function scalarRdfTerm(value: WorkScalarValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'integer': return '"0"^^<http://www.w3.org/2001/XMLSchema#integer>';
    case 'boolean': return '"false"^^<http://www.w3.org/2001/XMLSchema#boolean>';
    case 'string': return '""^^<http://www.w3.org/2001/XMLSchema#string>';
    case 'unknown': return `<${SCALAR_UNKNOWN}>`;
    case 'no-value': return `<${SCALAR_NO_VALUE}>`;
  }
}

export interface ScalarBinding { type: string; value: string; datatype?: string }

export function scalarFromBinding(binding?: ScalarBinding): WorkScalarValue | undefined {
  if (binding === undefined) return undefined;
  if (binding.type === 'uri' && binding.value === SCALAR_UNKNOWN) return { kind: 'unknown' };
  if (binding.type === 'uri' && binding.value === SCALAR_NO_VALUE) return { kind: 'no-value' };
  if (binding.type === 'literal' && binding.value === '0' && binding.datatype === `${XSD}integer`) {
    return { kind: 'integer', lexical: '0' };
  }
  if (binding.type === 'literal' && binding.value === 'false' && binding.datatype === `${XSD}boolean`) {
    return { kind: 'boolean', lexical: 'false' };
  }
  if (binding.type === 'literal' && binding.value === ''
    && (binding.datatype === `${XSD}string` || binding.datatype === undefined)) {
    return { kind: 'string', lexical: '' };
  }
  throw new InvalidWorkScalarValue('Work scalar RDF term is unsupported');
}

export function sameScalar(a: WorkScalarValue | undefined, b: WorkScalarValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kind === b.kind && ('lexical' in a ? 'lexical' in b && a.lexical === b.lexical
    : !('lexical' in b));
}

/** An exact, expanded JSON-LD export with no synthetic RDF triple for absence. */
export function scalarExport(work: string, value: WorkScalarValue | undefined): Record<string, unknown> {
  const object = value === undefined ? undefined
    : value.kind === 'unknown' ? { '@id': SCALAR_UNKNOWN }
      : value.kind === 'no-value' ? { '@id': SCALAR_NO_VALUE }
        : { '@value': value.lexical, '@type': `${XSD}${value.kind === 'integer' ? 'integer'
          : value.kind === 'boolean' ? 'boolean' : 'string'}` };
  return { '@id': work, ...(object === undefined ? {} : { [SCALAR_PREDICATE]: [object] }) };
}
