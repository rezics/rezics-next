import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { subjectReadEligibility } from '../../src/semantic/eligibility.ts';

test('the subject read policy is one exported binding', () => {
  expect(subjectReadEligibility({ route: 0, id: '019a1b2c-3d4e-7f00-8a00-5b0000000061' })).toBeDefined();
  const routes = readFileSync(new URL('../../src/semantic/http/subjects.ts', import.meta.url), 'utf8');
  expect(routes).toContain('subjectReadEligibility');
  expect(routes).not.toContain('createResourcePublicEligibility');
});
