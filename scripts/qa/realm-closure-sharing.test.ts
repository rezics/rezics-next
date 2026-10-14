import { expect, test } from 'bun:test';
import { isolatedIntegrationFileList } from './isolated-integration-files.ts';

test('Realm closure outcomes exercise the population left by other files', () => {
  for (const name of ['closure-search', 'closure-directory']) {
    expect(isolatedIntegrationFileList as readonly string[]).not.toContain(
      `tests/qa/integration/outcomes/realm/${name}.test.ts`,
    );
  }
});
