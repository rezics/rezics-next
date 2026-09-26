import { expect, test } from 'bun:test';
import { checkedWorkScalarValue, InvalidWorkScalarValue, sameScalar,
  scalarExport, scalarFromBinding, scalarRdfTerm, SCALAR_NO_VALUE, SCALAR_PREDICATE,
  SCALAR_UNKNOWN, type WorkScalarValue } from '../src/modules/work/scalar-value.ts';
import { metadataWorkEditDigest, workScalarEditDigest } from '../src/modules/work/edit.ts';

const work = 'https://rezics.com/id/01990000-0000-7000-8000-000000000001';
const head = 'https://rezics.com/id/01990000-0000-7000-8000-000000000002';

test('MODEL02 schema: six Work scalar states have distinct lexical, RDF and JSON-LD forms', () => {
  const states: readonly (WorkScalarValue | undefined)[] = [
    { kind: 'integer', lexical: '0' }, { kind: 'boolean', lexical: 'false' },
    { kind: 'string', lexical: '' }, undefined, { kind: 'unknown' }, { kind: 'no-value' },
  ];
  expect(new Set(states.map(value => JSON.stringify(scalarExport(work, value)))).size).toBe(6);
  expect(new Set(states.map(value => scalarRdfTerm(value) ?? 'absent')).size).toBe(6);
  expect(new Set(states.map(value => workScalarEditDigest(work, head, value))).size).toBe(6);
  expect(states.map(value => checkedWorkScalarValue(value))).toEqual([...states]);
  expect(scalarExport(work, undefined)).toEqual({ '@id': work });
  expect(scalarExport(work, { kind: 'unknown' })[SCALAR_PREDICATE]).toEqual([{ '@id': SCALAR_UNKNOWN }]);
  expect(scalarExport(work, { kind: 'no-value' })[SCALAR_PREDICATE]).toEqual([{ '@id': SCALAR_NO_VALUE }]);
  expect(workScalarEditDigest(work, head, undefined)).not.toBe(metadataWorkEditDigest(work, head, 'Title'));
  const reordered = { lexical: '0', kind: 'integer' } as const;
  expect(checkedWorkScalarValue(reordered)).toEqual({ kind: 'integer', lexical: '0' });
  expect(sameScalar(reordered, states[0])).toBe(true);
  expect(workScalarEditDigest(work, head, reordered)).toBe(workScalarEditDigest(work, head, states[0]));
  for (const [value, binding] of [
    [states[0], { type: 'literal', value: '0', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }],
    [states[1], { type: 'literal', value: 'false', datatype: 'http://www.w3.org/2001/XMLSchema#boolean' }],
    [states[2], { type: 'literal', value: '', datatype: 'http://www.w3.org/2001/XMLSchema#string' }],
    [states[4], { type: 'uri', value: SCALAR_UNKNOWN }],
    [states[5], { type: 'uri', value: SCALAR_NO_VALUE }],
  ] as const) expect(sameScalar(value, scalarFromBinding(binding))).toBe(true);
});

test('MODEL02 schema rejects null, numeric coercion, false truthiness, and unsupported lexical values', () => {
  for (const value of [null, 0, false, '', {}, { kind: 'integer', lexical: 0 },
    { kind: 'integer', lexical: '00' }, { kind: 'boolean', lexical: false },
    { kind: 'string', lexical: ' ' }, { kind: 'unknown', lexical: '' },
    { kind: 'no-value', extra: true }]) {
    expect(() => checkedWorkScalarValue(value)).toThrow(InvalidWorkScalarValue);
  }
  expect(() => scalarFromBinding({ type: 'literal', value: '00',
    datatype: 'http://www.w3.org/2001/XMLSchema#integer' })).toThrow(InvalidWorkScalarValue);
});
