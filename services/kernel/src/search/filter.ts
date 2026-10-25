import type { FieldError, FieldErrorCode } from '../http/problem.ts';

export const FILTER_LIMITS = Object.freeze({ leaves: 32, depth: 4, or: 16, in: 64 } as const);

export type FilterDocument =
  | { readonly and: readonly FilterDocument[] }
  | { readonly or: readonly FilterDocument[] }
  | { readonly not: FilterDocument }
  | { readonly type: { readonly in: readonly string[] } }
  | { readonly statement: { readonly property: string; readonly in: readonly string[] } };

type FilterProblem = 'invalid_request' | 'unsupported_query';

export class FilterError extends Error {
  readonly problem: FilterProblem;
  readonly errors: FieldError[];

  constructor(problem: FilterProblem, pointer: string, code: FieldErrorCode) {
    super(`${problem}: ${code} at ${pointer || '(root)'}`);
    this.name = 'FilterError';
    this.problem = problem;
    this.errors = [{ pointer, code }];
  }
}

function fail(pointer: string, code: FieldErrorCode, problem: FilterProblem = 'invalid_request'): never {
  throw new FilterError(problem, pointer, code);
}

function appendPointer(pointer: string, key: string | number): string {
  return `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function object(input: unknown, pointer: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(pointer, 'invalid_type');
  return input as Record<string, unknown>;
}

// Missing array elements must not resolve through Array.prototype either.
function ownValue(input: object, key: string | number, pointer: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(pointer, 'invalid_type');
  return descriptor.value;
}

function array(input: unknown, pointer: string, limit?: number): unknown[] {
  if (!Array.isArray(input)) fail(pointer, 'invalid_type');
  if (input.length === 0) fail(pointer, 'out_of_range');
  if (limit !== undefined && input.length > limit) fail(pointer, 'out_of_range', 'unsupported_query');
  return input;
}

const curiePattern = /^[a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9_]*$/;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;
const encoder = new TextEncoder();

function stringValue(input: unknown, pointer: string, curie: boolean): string {
  if (typeof input !== 'string') fail(pointer, 'invalid_type');
  const maxBytes = curie ? 128 : 256;
  if (
    input.length === 0 ||
    input.length > maxBytes ||
    controlCharacters.test(input) ||
    (curie && curiePattern.exec(input)?.[0] !== input) ||
    encoder.encode(input).byteLength > maxBytes
  )
    fail(pointer, 'invalid_format');
  return input;
}

function values(input: unknown, pointer: string, curie: boolean): string[] {
  const items = array(input, pointer, FILTER_LIMITS.in);
  const result: string[] = [];
  for (let index = 0; index < items.length; index++) {
    const itemPointer = appendPointer(pointer, index);
    result.push(stringValue(ownValue(items, index, itemPointer), itemPointer, curie));
  }
  return result;
}

function facet(input: unknown, pointer: string, statement: boolean): { property: string; in: string[] } {
  const fields = object(input, pointer);
  let property = '';
  let selected: string[] | undefined;
  for (const key of Object.getOwnPropertyNames(fields)) {
    const fieldPointer = appendPointer(pointer, key);
    if (key === 'property' && statement) {
      property = stringValue(ownValue(fields, key, fieldPointer), fieldPointer, true);
    } else if (key === 'in') {
      selected = values(ownValue(fields, key, fieldPointer), fieldPointer, !statement);
    } else {
      fail(fieldPointer, 'unknown_field');
    }
  }
  if (statement && !Object.hasOwn(fields, 'property')) fail(appendPointer(pointer, 'property'), 'required');
  if (selected === undefined) fail(appendPointer(pointer, 'in'), 'required');
  return { property, in: selected };
}

export function parseFilter(input: unknown): FilterDocument {
  let leaves = 0;

  function node(input: unknown, pointer: string, depth: number, underNot: boolean): FilterDocument {
    const fields = object(input, pointer);
    const keys = Object.getOwnPropertyNames(fields);
    if (keys.length !== 1) fail(pointer, 'unsupported');
    const key = keys[0]!;
    const fieldPointer = appendPointer(pointer, key);
    switch (key) {
      case 'and':
      case 'or': {
        if (depth >= FILTER_LIMITS.depth) fail(pointer, 'out_of_range', 'unsupported_query');
        const items = array(
          ownValue(fields, key, fieldPointer),
          fieldPointer,
          key === 'or' ? FILTER_LIMITS.or : undefined,
        );
        const children: FilterDocument[] = [];
        for (let index = 0; index < items.length; index++) {
          const childPointer = appendPointer(fieldPointer, index);
          children.push(node(ownValue(items, index, childPointer), childPointer, depth + 1, false));
        }
        return key === 'and' ? { and: children } : { or: children };
      }
      case 'not':
        if (underNot) fail(pointer, 'unsupported', 'unsupported_query');
        if (depth >= FILTER_LIMITS.depth) fail(pointer, 'out_of_range', 'unsupported_query');
        return { not: node(ownValue(fields, key, fieldPointer), fieldPointer, depth + 1, true) };
      case 'type':
      case 'statement': {
        if (++leaves > FILTER_LIMITS.leaves) fail('', 'out_of_range', 'unsupported_query');
        const parsed = facet(ownValue(fields, key, fieldPointer), fieldPointer, key === 'statement');
        return key === 'type' ? { type: { in: parsed.in } } : { statement: parsed };
      }
      default:
        return fail(fieldPointer, 'unknown_field');
    }
  }

  return node(input, '', 0, false);
}

export function positiveFilter(filter: FilterDocument): boolean {
  if ('not' in filter) return false;
  if ('and' in filter) return filter.and.some(positiveFilter);
  if ('or' in filter) return filter.or.every(positiveFilter);
  return true;
}

type FilterClause =
  | { terms: { type: string[]; _name: string } }
  | { terms: { statements: string[]; _name: string } }
  | { bool: { filter?: FilterClause[]; must_not?: FilterClause[] } }
  | { bool: { should: FilterClause[]; minimum_should_match: 1 } };

type FilterLeaf =
  | { name: string; facet: 'type'; values: string[]; negated: boolean }
  | { name: string; facet: 'statement'; property: string; values: string[]; negated: boolean };

export function compileFilter(
  filter: FilterDocument,
  { prefix }: { prefix: string },
): { query: FilterClause; leaves: FilterLeaf[] } {
  const leaves: FilterLeaf[] = [];

  function compile(node: FilterDocument, negated: boolean): FilterClause {
    if ('and' in node) {
      const clauses: FilterClause[] = [];
      const excluded: FilterClause[] = [];
      for (const child of node.and) {
        if ('not' in child) excluded.push(compile(child.not, !negated));
        else clauses.push(compile(child, negated));
      }
      return {
        bool: { ...(clauses.length ? { filter: clauses } : {}), ...(excluded.length ? { must_not: excluded } : {}) },
      };
    }
    if ('or' in node) {
      return { bool: { should: node.or.map((child) => compile(child, negated)), minimum_should_match: 1 } };
    }
    if ('not' in node) return { bool: { must_not: [compile(node.not, !negated)] } };

    const name = `${prefix}${leaves.length}`;
    if ('type' in node) {
      const values = [...node.type.in];
      leaves.push({ name, facet: 'type', values, negated });
      return { terms: { type: values, _name: name } };
    }
    const { property } = node.statement;
    const values = [...node.statement.in];
    leaves.push({ name, facet: 'statement', property, values, negated });
    return { terms: { statements: values.map((value) => `${property}=${value}`), _name: name } };
  }

  return { query: compile(filter, false), leaves };
}
