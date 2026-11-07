import { expect, test } from 'bun:test';
import { composeSearchNativePorts } from '../../src/composition/search-native.ts';
import { SEARCH_GLOBAL_CONTEXT } from '../../src/search/global-context.ts';
import { subjectSource, withReadTransaction } from '../../src/search/native-bindings.ts';
import { withReadTransaction as semanticWithReadTransaction } from '../../src/semantic/read.ts';
import { subjectSource as semanticSubjectSource } from '../../src/semantic/search-source.ts';

test('bound Search native ports keep producer identity', () => {
  composeSearchNativePorts();
  expect(withReadTransaction).toBe(semanticWithReadTransaction);
  expect(subjectSource).toBe(semanticSubjectSource);
  expect(SEARCH_GLOBAL_CONTEXT.id).toBe('00000000-0000-8000-8000-000000000000');
  expect(SEARCH_GLOBAL_CONTEXT.route).toBe(0);
});
