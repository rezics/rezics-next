import { expect, test } from 'bun:test';
import { checkProductionEnv } from '../production-env.ts';

test('production preflight refuses REZICS_PLATFORM_OPEN_GROUPS', () => {
  for (const value of ['*', 'saved-views', '', ' ']) {
    expect(() => checkProductionEnv({ REZICS_PLATFORM_OPEN_GROUPS: value }, [])).toThrow(
      'Production forbids REZICS_PLATFORM_OPEN_GROUPS',
    );
  }
});

test('production preflight allows an environment that does not set open platform groups', () => {
  try {
    checkProductionEnv({}, []);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('REZICS_PLATFORM_OPEN_GROUPS');
  }
});
