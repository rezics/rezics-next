import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { caseInventory } from '../../../scripts/qa/acceptance.ts';
import { selectBackendCases } from '../../../scripts/qa/backend-scope.ts';

const root = resolve(import.meta.dir, '../../..');

function expand(value: string): string[] {
  const match = /^([A-Z]+)(\d{2})(?:-([A-Z]+)(\d{2}))?$/.exec(value);
  if (!match || match[3] && match[3] !== match[1]) throw new Error(`Invalid mapped ID range ${value}`);
  const start = Number(match[2]);
  const end = match[4] ? Number(match[4]) : start;
  if (end < start || end - start > 50) throw new Error(`Invalid mapped ID span ${value}`);
  return Array.from({ length: end - start + 1 }, (_, index) =>
    `${match[1]}${String(start + index).padStart(2, '0')}`);
}

test('OPS01: every frozen backend case has one concrete owner API operation target', () => {
  const text = readFileSync(join(root, 'docs/plan/backend-operations.md'), 'utf8');
  const spec = JSON.parse(readFileSync(join(root, 'generated/openapi/main/public.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const mapped = new Map<string, string>();
  for (const match of text.matchAll(/^\| ([A-Z]+\d{2}(?:-[A-Z]+\d{2})?) \| (.+) \|$/gm)) {
    const operation = match[2]!;
    expect(operation).toMatch(/\b[EP] `(?:GET|POST|PATCH|DELETE) \/(?:v1\/|health\/ready)|\bE `\/api\/auth\/\*`/);
    for (const id of expand(match[1]!)) {
      if (mapped.has(id)) throw new Error(`Duplicate operation mapping for ${id}`);
      mapped.set(id, operation);
    }
    for (const route of operation.matchAll(/\bE `(GET|POST|PATCH|DELETE) (\/v1\/[^`]+)`/g)) {
      if (!spec.paths[route[2]!]?.[route[1]!.toLowerCase()]) {
        throw new Error(`Mapped existing route is absent: ${route[1]} ${route[2]}`);
      }
    }
  }
  const selected = selectBackendCases(caseInventory(root)).cases.map(item => item.id);
  expect([...mapped.keys()].sort()).toEqual(selected);
  expect(mapped.size).toBe(276);
  expect(mapped.has('VIEW04')).toBe(false);
});
