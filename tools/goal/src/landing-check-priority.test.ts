import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANDING_CHECK_ENVIRONMENT } from './config.ts';
import { gateRunner } from './merge.ts';
import { temporaryDirectory } from './test-support.ts';

test('landing commands run with the landing check priority, and other gate commands do not', async () => {
  const t = temporaryDirectory();
  try {
    const script = ['sh', '-c', 'printf "%s" "${REMOTE_CHECK_PRIORITY:-none}" > priority.txt'];
    await gateRunner(60_000, undefined, LANDING_CHECK_ENVIRONMENT)(script, t.path, join(t.path, 'landing.log'));
    expect(readFileSync(join(t.path, 'priority.txt'), 'utf8')).toBe('landing');
    await gateRunner(60_000)(script, t.path, join(t.path, 'other.log'));
    expect(readFileSync(join(t.path, 'priority.txt'), 'utf8')).toBe('none');
  } finally {
    t.close();
  }
});
