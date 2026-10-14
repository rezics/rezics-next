import { test } from 'bun:test';
import { runIndependentRestoreDrill } from './independent-restore-support.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';

// Measured blocked attempt: 264.4 s (source startup 51.0 s, backup 76.8 s,
// current capture 5.7 s). Native Access capture refused a changed
// realm_directory_position before child restore. The 600 s file budget includes
// two 180 s child commands; phase JSONL retains admission and active costs.
test('OPS12: artifact-only restore uses immutable C0 and independently retained C1/D/J1 after source destruction',
  async () => runIndependentRestoreDrill(false), qaStartupTestTimeout(600_000));
