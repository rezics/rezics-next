import { expect, test } from 'bun:test';
import { capture } from './test-lanes.ts';

test('capture completes when both output streams close before the child exits', async () => {
  const result = await capture('/bin/sh', ['-c', 'exec 1>&- 2>&-; sleep 0.1; exit 7'], process.env, process.cwd(), {
    file: 'early-eof.fixture',
    silence: 2,
    wall: 3,
    killGraceMs: 50,
    progressInterval: 1,
  });
  expect(result.status).toBe(7);
  expect(result.output).toBe('');
  expect(result.stopped).toBeUndefined();
});

test('capture drains a descendant output stream after the leader exits', async () => {
  const result = await capture(
    '/bin/sh',
    ['-c', '(sleep 0.1; echo descendant-tail) & exit 0'],
    process.env,
    process.cwd(),
    {
      file: 'late-eof.fixture',
      silence: 2,
      wall: 3,
      killGraceMs: 50,
      progressInterval: 1,
    },
  );
  expect(result.status).toBe(0);
  expect(result.output).toContain('descendant-tail');
  expect(result.stopped).toBeUndefined();
});
