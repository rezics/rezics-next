import { expect, test } from 'bun:test';
import { ownerConflictEnvironment } from './owner-conflict.ts';
import { repository } from './test-support.ts';

const secret = 'credential-should-not-leak';

function withEnv(values: Record<string, string>, run: () => void) {
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('valid inherited Git configuration survives scoped recovery', () => {
  const repo = repository();
  try {
    withEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.proxy', GIT_CONFIG_VALUE_0: secret }, () => {
      const next = ownerConflictEnvironment(repo.main);
      expect(next).toMatchObject({
        GIT_CONFIG_COUNT: '4',
        GIT_CONFIG_KEY_1: 'rerere.enabled',
        GIT_CONFIG_VALUE_1: 'true',
        GIT_CONFIG_KEY_2: 'rerere.autoupdate',
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
      });
      expect(next.GIT_CONFIG_VALUE_3).toContain('rr-cache');
      expect(next).not.toHaveProperty('GIT_CONFIG_KEY_0');
      expect(process.env.GIT_CONFIG_VALUE_0).toBe(secret);
    });
  } finally {
    repo.close();
  }
});

test('malformed, incomplete or overflowing inherited configuration fails without replacing entries or exposing values', () => {
  const inherited = { GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: secret };
  for (const values of [
    { ...inherited, GIT_CONFIG_COUNT: 'bogus' },
    { ...inherited, GIT_CONFIG_COUNT: '2' },
    { ...inherited, GIT_CONFIG_COUNT: String(Number.MAX_SAFE_INTEGER) },
  ])
    withEnv(values, () => {
      let message = '';
      try {
        ownerConflictEnvironment('/nonexistent');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/inherited GIT_CONFIG/);
      expect(message).not.toContain(secret);
      expect(process.env.GIT_CONFIG_VALUE_0).toBe(secret);
    });
});
