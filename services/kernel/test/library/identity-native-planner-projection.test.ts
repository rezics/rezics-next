import { expect, test } from 'bun:test';
import { sql as compiledJobSQL } from '../../src/library/identity-native-planner-job.sql';
import { sql as compiledPlanSQL } from '../../src/library/identity-native-planner-read.sql';
import {
  libraryIdentityBoundedJobSQL,
  libraryIdentityBoundedPlanSQL,
} from '../../src/library/identity-native-planner-projection.ts';

test('native planner projections are owned by the Reylo SQL statements', () => {
  expect(libraryIdentityBoundedPlanSQL()).toBe(compiledPlanSQL);
  expect(libraryIdentityBoundedJobSQL()).toBe(compiledJobSQL);
  expect(compiledPlanSQL).toMatch(/\bprojection_valid\b/i);
  expect(compiledPlanSQL).toMatch(/\bbounds\.old_state_valid\b/i);
  expect(compiledJobSQL).toMatch(/\bscope_digest\b/i);
});
