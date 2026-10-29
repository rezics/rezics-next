import { expect } from 'bun:test';
import type { BatchStatement } from '@rezics/definitions/bulk';
import type { Statement } from '../../src/semantic/item.ts';

export function unresolved(statement: BatchStatement | Statement, key: string, wire: 'proposal' | 'native' = 'proposal') {
  expect(statement.value).toEqual({ type: 'somevalue' });
  expect(statement.qualifiers).toContainEqual<Statement['qualifiers'] | NonNullable<BatchStatement['qualifiers']>>({
    property: wire === 'native' ? { id: 'wdt:P648', data_type: 'external-id' } : { id: 'wdt:P648' },
    value: { type: 'value', content: key.split('/').at(-1) },
  });
}
