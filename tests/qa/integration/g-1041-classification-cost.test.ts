import { test } from 'bun:test';
import { runWorkProfileChild } from '../support/work-profile-child.ts';

// A finite child owns the SDK and sink even after another file shuts down its
// process-global provider. The child asserts every response and cost bound.
test('G1041: classification pages and build batches keep fixed owner exchanges at catalogue scale', async () => {
  await runWorkProfileChild('tests/qa/support/work-profile-classification-child.ts', {
    env: { OTEL_SERVICE_NAME: 'g-1041-classification' },
    timeoutMs: 170_000,
  });
}, 180_000);
