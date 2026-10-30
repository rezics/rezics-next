import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRuntime, loadSettings } from './config.ts';
import { harness } from './test-support.ts';

test('the landing train uses the locally configured affected checks, including none', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.affectedTests = [];
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const settings = loadSettings({ cwd: h.root, env: {} });
    const runtime = createRuntime({ settings });
    try {
      const train = (runtime as unknown as { train: { options: { affectedTests?: unknown } } }).train;
      expect(train.options.affectedTests).toEqual([]);
    } finally {
      runtime.close();
    }
  } finally {
    h.dispose();
  }
});
