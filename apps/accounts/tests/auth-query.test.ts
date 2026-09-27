import { expect, test } from 'bun:test';
import { authorizationAfterCreate, authorizationAfterVerification } from '../features/auth/auth-query.ts';

test('verified signup resumes PKCE without the one-time create prompt or stale signature', () => {
  const next = authorizationAfterCreate('response_type=code&client_id=reader&state=opaque&prompt=create'
    + '&code_challenge=challenge&ba_param=state&sig=old&exp=123&ba_iat=100');
  expect(next).toBe('/api/auth/oauth2/authorize?response_type=code&client_id=reader&state=opaque'
    + '&code_challenge=challenge');
  expect(authorizationAfterCreate('response_type=code&prompt=login')).toBeUndefined();
  expect(authorizationAfterVerification('response_type=code&client_id=reader&state=opaque&prompt=login'
    + '&ba_param=state&sig=old')).toBe('/api/auth/oauth2/authorize?response_type=code&client_id=reader'
    + '&state=opaque&prompt=login');
});
