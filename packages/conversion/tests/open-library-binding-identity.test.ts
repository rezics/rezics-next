import { expect, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { convertOpenLibrary, converter_revision } from '../src/open-library.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const firstAuthor = '00000000-0000-4000-8000-000000000002';
const secondAuthor = '00000000-0000-4000-8000-000000000003';
const input = {
  external_id: '/works/OL1W',
  record_revision: '1',
  record: {
    type: { key: '/type/work' },
    key: '/works/OL1W',
    revision: 1,
    title: 'Book',
    last_modified: { value: '2025-01-02T03:04:05' },
    authors: [{ author: { key: '/authors/OL1A' } }],
  },
};
function conversion(author?: string, unrelated?: string) {
  return convertOpenLibrary(input, {
    subjectId,
    resolvedReferences: {
      ...(author ? { '/authors/OL1A': author } : {}),
      ...(unrelated ? { '/authors/OL999A': unrelated } : {}),
    },
  });
}
function statement(output: ReturnType<typeof conversion>, property: string) {
  const found = output.proposals.find(
    (command) => command.op === 'propose' && command.statement.property.id === property,
  );
  if (!found || found.op !== 'propose') throw new Error('Expected source proposal');
  return found;
}
test('unresolved and resolved author bodies have distinct stable proposal identities', () => {
  const unresolved = conversion();
  const resolved = conversion(firstAuthor);
  const rebound = conversion(secondAuthor);
  for (const output of [unresolved, resolved, rebound]) {
    expect(checkBatchWrite({ commands: [...output.proposals] })).toEqual([]);
    expect(output.digest).toBe(unresolved.digest);
    expect(output.record_revision).toBe('1');
  }
  const unknown = statement(unresolved, 'schema:author');
  const first = statement(resolved, 'schema:author');
  const second = statement(rebound, 'schema:author');
  expect(unknown.statement.value).toEqual({ type: 'somevalue' });
  expect(first.statement.value).toEqual({ type: 'value', content: firstAuthor });
  expect(second.statement.value).toEqual({ type: 'value', content: secondAuthor });
  expect(new Set([unknown.key, first.key, second.key]).size).toBe(3);
  expect(first.statement.references).toEqual(unknown.statement.references);
  expect(statement(resolved, 'schema:name').key).toBe(statement(unresolved, 'schema:name').key);
  expect(statement(rebound, 'schema:name').key).toBe(statement(unresolved, 'schema:name').key);
  expect(conversion()).toEqual(unresolved);
  expect(conversion(firstAuthor)).toEqual(resolved);
  expect(conversion(secondAuthor)).toEqual(rebound);
  expect(conversion(firstAuthor, secondAuthor)).toEqual(resolved);
  const bodies = new Map<string, string>();
  for (const output of [unresolved, resolved, rebound, conversion(firstAuthor)]) {
    for (const command of output.proposals) {
      const body = JSON.stringify(command);
      const previous = bodies.get(command.key);
      if (previous !== undefined) expect(body).toBe(previous);
      bodies.set(command.key, body);
    }
  }
});
test('binding identity repair publishes a new converter revision', () => {
  expect(converter_revision as string).not.toBe('open-library@2');
});
