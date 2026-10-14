import { test } from 'bun:test';
import { runIndependentRestoreDrill } from './independent-restore-support.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';

// Measured blocked attempt: 328.5 s (source startup 74.9 s, membership 1.2 s,
// backup 107.6 s, current capture 9.3 s). Native Access capture refused a changed
// realm_directory_position before child restore. The 600 s file budget includes
// one 180 s child command; phase JSONL and timing artifacts retain active costs.
test('OPS16: artifact-only deployment restores the API Recipe cut and converges with production workers running',
  async () => runIndependentRestoreDrill(true), qaStartupTestTimeout(600_000));
