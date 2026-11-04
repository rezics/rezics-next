import { expect, test } from 'bun:test';
import { sql as compiledPlanSQL } from '../../src/library/identity-native-planner-read.sql';
import { libraryIdentityBoundedPlanSQL } from '../../src/library/identity-native-planner-projection.ts';

test('native plan projection is owned by the Reylo SQL statement', () => {
  expect(libraryIdentityBoundedPlanSQL).toBe(compiledPlanSQL);
  expect(compiledPlanSQL).toMatch(/\bprojection_valid\b/i);
  expect(compiledPlanSQL).toMatch(/\bbounds\.old_state_valid\b/i);
});
