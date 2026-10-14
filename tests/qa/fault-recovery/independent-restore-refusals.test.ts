import { test } from 'bun:test';
import { runIndependentRestoreDrill } from './independent-restore-support.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';

// The original authority drill's missing-custody child is also independently selectable.
test('OPS12: artifact-only restore refuses missing native Access custody and retains both holds',
  async () => runIndependentRestoreDrill(false, true), qaStartupTestTimeout(600_000));
