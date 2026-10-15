import { test } from 'bun:test';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { qualifyRetainedContentRefusal } from './retained-content-source-consumer.ts';

test('D016: missing required Content field refuses native compatibility startup on an isolated copy', async () => {
  await qualifyRetainedContentRefusal('missing');
}, qaStartupTestTimeout(360_000));
