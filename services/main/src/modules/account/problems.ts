import { problem, t } from 'elysia';
import { dependencyUnavailable, problemDefinition, type ProblemSet } from '../problem.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from './verify-assertion.ts';

export const accountAssertionDenied = problemDefinition(401, 'account_assertion_denied', 'Account assertion is invalid or inactive');
export const invalidAccountAssertion = problemDefinition(401, 'invalid_account_assertion', 'Account assertion refused');
export const accountProblems = {
  401: t.Union([accountAssertionDenied.schema, invalidAccountAssertion.schema]),
};

export function accountFailure(error: unknown, set: ProblemSet) {
  if (error instanceof AccountAssertionDenied) {
    set.headers['www-authenticate'] = 'Bearer';
    return problem(accountAssertionDenied.body);
  }
  if (error instanceof AccountAssertionUnavailable) {
    set.headers['retry-after'] = '1';
    return problem({ ...dependencyUnavailable.body, title: 'A required authority service is unavailable' });
  }
}
