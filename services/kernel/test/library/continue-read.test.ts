import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Value } from 'typebox/value';
import { continuePageSchema } from '../../src/library/transport-contract.ts';

const source = resolve(import.meta.dir, '../../src');
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });

function runtimeImports(file: string): string[] {
  return transpiler.scanImports(readFileSync(resolve(source, file), 'utf8')).map(({ path }) => path);
}

const page = {
  subjects: [
    {
      subjectId: '018f2f4b-7c00-7000-8000-000000000001',
      state: null,
      lastActivityAt: '2026-10-31T00:00:00.000001Z',
      activeProgressSession: null,
    },
  ],
  next: null,
};
const header = {
  id: page.subjects[0]!.subjectId,
  type: 'schema:Book',
  types: ['schema:Book', 'schema:CreativeWork'],
  label: { value: 'A book', language: 'en' },
  creativeWork: true,
  cover: null,
};

test('Continue response keeps BASIC closed and permits only the nullable native FULL subject summary', () => {
  expect(Value.Check(continuePageSchema, page)).toBe(true);
  expect(
    Value.Check(continuePageSchema, {
      ...page,
      subjects: [{ ...page.subjects[0], subject: header }],
    }),
  ).toBe(true);
  expect(
    Value.Check(continuePageSchema, {
      ...page,
      subjects: [{ ...page.subjects[0], subject: null }],
    }),
  ).toBe(true);
  expect(
    Value.Check(continuePageSchema, {
      ...page,
      subjects: [{ ...page.subjects[0], subject: { ...header, privatePins: [] } }],
    }),
  ).toBe(false);
});

test('Continue and Feed transport contracts do not depend on route handlers for schemas', () => {
  expect(runtimeImports('library/continue-routes.ts')).not.toContain('./progress-routes.ts');
  expect(runtimeImports('content/feed-contract.ts')).not.toContain('../library/continue-routes.ts');
  expect(runtimeImports('library/transport-contract.ts')).not.toContain('./progress-routes.ts');
});
