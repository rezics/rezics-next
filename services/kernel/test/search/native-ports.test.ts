import { expect, test } from 'bun:test';
import { composeSearchNativePorts } from '../../src/composition/search-native.ts';
import { SEARCH_GLOBAL_CONTEXT } from '../../src/search/global-context.ts';
import * as bindings from '../../src/search/native-bindings.ts';
import { subjectSource, withReadTransaction } from '../../src/search/native-bindings.ts';
import { searchSourcePublicationApplication } from '../../src/search/source-publication-application.ts';
import { withReadTransaction as semanticWithReadTransaction } from '../../src/semantic/read.ts';
import { subjectSource as semanticSubjectSource } from '../../src/semantic/search-source.ts';

test('bound Search native ports keep producer identity', () => {
  composeSearchNativePorts();
  expect(withReadTransaction).toBe(semanticWithReadTransaction);
  expect(subjectSource).toBe(semanticSubjectSource);
  expect(SEARCH_GLOBAL_CONTEXT.id).toBe('00000000-0000-8000-8000-000000000000');
  expect(SEARCH_GLOBAL_CONTEXT.route).toBe(0);

  // Direct bindings preserve generic transaction APIs, error constructors and typed native outcomes.
  const port = bindings.searchNativePorts();
  for (const name of Object.keys(port) as (keyof typeof port)[]) {
    expect(bindings[name]).toBe(port[name]);
  }
  expect(searchSourcePublicationApplication().subjectSource).toBe(port.subjectSource);
  expect(searchSourcePublicationApplication().publicFilterSource).toBe(port.publicFilterSource);
});
