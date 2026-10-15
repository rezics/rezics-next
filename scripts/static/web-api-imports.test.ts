import { dependencyAnalysis } from '../lib/dependency-analysis.ts';
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('feature modules cannot construct Eden clients outside the API adapters', () => {
  const fixture = mkdtempSync(join(root, '.temp/web-api-imports-'));
  try {
    const features = join(fixture, 'apps/web/features');
    mkdirSync(join(features, 'example'), { recursive: true });
    writeFileSync(join(features, 'example/read.ts'), "import { treaty } from '@elysia/eden';\nexport { treaty };\n");
    const result = dependencyAnalysis(root, [ '--config', '.dependency-cruiser.json',
        '--output-type', 'err', relative(root, features)], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${Buffer.from(result.stdout)}${Buffer.from(result.stderr)}`)
      .toContain('web-eden-clients-live-at-api-boundary');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
