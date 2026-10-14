import { test } from 'bun:test';
import { resolve } from 'node:path';
import { runNativeModuleSuite } from '../../../scripts/qa/native-module-suite.ts';

test('the complete native module suite passes at the pinned build inputs', async () => {
  await runNativeModuleSuite(resolve(import.meta.dir, '../../..'));
}, 2_710_000);
