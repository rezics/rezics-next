import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { caseInventory } from '../../../scripts/qa/acceptance.ts';
import { selectBackendCases } from '../../../scripts/qa/backend-scope.ts';
import {
  backendOperationMappings,
  operationMap,
} from '../../../scripts/qa/cases/backend-operations.ts';

const root = resolve(import.meta.dir, '../../..');

test('OPS01: every frozen backend case has one checked owner API operation target', () => {
  const spec = JSON.parse(
    readFileSync(join(root, 'generated/openapi/main/public.json'), 'utf8'),
  ) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const selected = selectBackendCases(caseInventory(root)).cases;
  const mapped = operationMap(selected);
  expect(mapped.size).toBe(276);
  expect(mapped.has('VIEW04')).toBe(false);
  expect(backendOperationMappings).toHaveLength(130);
  const targetDigest = createHash('sha256')
    .update(JSON.stringify(backendOperationMappings.map(({ ids, targets }) => ({ ids, targets }))))
    .digest('hex');
  // Snapshot of the 130 E/P route groups before retiring the Markdown matrix.
  expect(targetDigest).toBe('040e7653e970bb04f2adf503994568c544f1f9622c81692378d71c5ddfc5c2db');
  for (const group of backendOperationMappings) {
    expect(group.ids.length).toBeGreaterThan(0);
    expect(group.targets.length).toBeGreaterThan(0);
    for (const target of group.targets) {
      expect(target.status === 'existing' || target.status === 'planned').toBe(true);
      if (target.path === '/api/auth/*') {
        expect(target.status).toBe('existing');
        expect(target.method).toBeUndefined();
      } else {
        expect(target.method).toMatch(/^(GET|POST|PATCH|DELETE|PUT)$/);
        expect(target.path).toMatch(/^\/(?:v[12]|health)\//);
        if (target.status === 'existing' && target.path.startsWith('/v')) {
          if (!spec.paths[target.path]?.[target.method!.toLowerCase()]) {
            throw new Error(`Mapped existing route is absent: ${target.method} ${target.path}`);
          }
        }
      }
    }
  }
  expect(() => operationMap(selected.filter((item) => item.id !== 'OPS01'))).toThrow(
    'unexpected OPS01',
  );
});
