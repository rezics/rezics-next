import { describe, expect, spyOn, test } from 'bun:test';
import { inspect } from 'node:util';
import { checkProductionEnv, productionSpecs, type ProductionRole } from '../production-env.ts';
import { productionExample } from './g-722-fixture.ts';

function roleEnv(role: ProductionRole): Record<string, string> {
  const complete = productionExample();
  return Object.fromEntries(
    Object.keys(productionSpecs[role])
      .filter((name) => complete[name] !== undefined)
      .map((name) => [name, complete[name]!]),
  );
}

describe('production Account security', () => {
  for (const name of [
    'ACCOUNT_SECRET',
    'ACCOUNT_MAIN_CLIENT_SECRET',
    'ACCOUNT_SMTP_HOST',
    'ACCOUNT_EMAIL_FROM',
  ]) {
    for (const value of ['', '   ']) {
      test(`refuses blank ${name} ${JSON.stringify(value)}`, () => {
        expect(() =>
          checkProductionEnv({ ...roleEnv('account'), [name]: value }, ['account']),
        ).toThrow(name);
      });
    }
  }
  for (const host of ['<SMTP_HOST>', 'smtp.example.com', 'smtp.rezics.test', 'mailpit.internal']) {
    test(`refuses placeholder or development SMTP host ${host}`, () => {
      expect(() =>
        checkProductionEnv({ ...roleEnv('account'), ACCOUNT_SMTP_HOST: host }, ['account']),
      ).toThrow('ACCOUNT_SMTP_HOST');
    });
  }
  for (const key of [
    undefined,
    '',
    '   ',
    '1x0000000000000000000000000000000AA',
    '2x0000000000000000000000000000000AA',
    '3x0000000000000000000000000000000AA',
    ' 1x0000000000000000000000000000000AA ',
    '<TURNSTILE_SECRET>',
    'changeme',
  ]) {
    test(`refuses missing, test or placeholder Turnstile secret ${JSON.stringify(key)}`, () => {
      expect(() =>
        checkProductionEnv({ ...roleEnv('account'), ACCOUNT_TURNSTILE_SECRET_KEY: key }, [
          'account',
        ]),
      ).toThrow('ACCOUNT_TURNSTILE_SECRET_KEY');
    });
  }
  test('forces production validation despite a development environment', () => {
    const env = { ...roleEnv('account'), NODE_ENV: 'development', ACCOUNT_TURNSTILE_MODE: 'local' };
    expect(() => checkProductionEnv(env, ['account'])).toThrow('ACCOUNT_TURNSTILE_SECRET_KEY');
    expect(env.NODE_ENV).toBe('development');
  });
  test('reuses Account deletion dependency validation', () => {
    const env = roleEnv('account');
    delete env.ACCOUNT_RELAY_DATABASE_URL;
    expect(() => checkProductionEnv(env, ['account'])).toThrow('ACCOUNT_RELAY_DATABASE_URL');
  });
  for (const secret of [
    'short-mail-secret',
    'a'.repeat(31),
    ' '.repeat(32),
    'password',
    'changeme',
    '<MAIL_EVENTS_SECRET>',
  ]) {
    test(`refuses unsafe enabled mail-event secret ${JSON.stringify(secret)}`, () => {
      expect(() =>
        checkProductionEnv({ ...roleEnv('account'), ACCOUNT_MAIL_EVENTS_SECRET: secret }, [
          'account',
        ]),
      ).toThrow('ACCOUNT_MAIL_EVENTS_SECRET');
    });
  }
  for (const secret of [undefined, '', 'a'.repeat(32)]) {
    test(`accepts disabled or securely configured mail intake ${JSON.stringify(secret)}`, () => {
      expect(() =>
        checkProductionEnv({ ...roleEnv('account'), ACCOUNT_MAIL_EVENTS_SECRET: secret }, [
          'account',
        ]),
      ).not.toThrow();
    });
  }
  for (const password of [
    undefined,
    '',
    '   ',
    'secret',
    ' password ',
    'changeme',
    '<SMTP_PASSWORD>',
  ]) {
    test(`refuses unsafe SMTP credentials ${JSON.stringify(password)}`, () => {
      expect(() =>
        checkProductionEnv(
          {
            ...roleEnv('account'),
            ACCOUNT_SMTP_USER: 'smtp-user',
            ACCOUNT_SMTP_PASSWORD: password,
          },
          ['account'],
        ),
      ).toThrow('ACCOUNT_SMTP_PASSWORD');
    });
  }
  test('refuses a password without an SMTP user', () => {
    expect(() =>
      checkProductionEnv(
        { ...roleEnv('account'), ACCOUNT_SMTP_PASSWORD: 'provisioned-smtp-credential' },
        ['account'],
      ),
    ).toThrow('ACCOUNT_SMTP_USER');
  });
  test('refuses SMTP without TLS', () => {
    expect(() =>
      checkProductionEnv(
        { ...roleEnv('account'), ACCOUNT_SMTP_SECURE: 'false', ACCOUNT_SMTP_REQUIRE_TLS: 'false' },
        ['account'],
      ),
    ).toThrow('ACCOUNT_SMTP_SECURE or ACCOUNT_SMTP_REQUIRE_TLS');
  });
  for (const tls of ['ACCOUNT_SMTP_SECURE', 'ACCOUNT_SMTP_REQUIRE_TLS']) {
    for (const authenticated of [true, false]) {
      test(`accepts ${tls} with ${authenticated ? 'authenticated' : 'unauthenticated'} SMTP`, () => {
        expect(() =>
          checkProductionEnv(
            {
              ...roleEnv('account'),
              ACCOUNT_SMTP_SECURE: 'false',
              ACCOUNT_SMTP_REQUIRE_TLS: 'false',
              [tls]: 'true',
              ACCOUNT_SMTP_USER: authenticated ? 'smtp-user' : '',
              ACCOUNT_SMTP_PASSWORD: authenticated ? 'provisioned-smtp-credential' : '',
            },
            ['account'],
          ),
        ).not.toThrow();
      });
    }
  }
});

describe('production Accounts enrollment', () => {
  for (const key of [
    undefined,
    '',
    '   ',
    '1x00000000000000000000AA',
    '2x00000000000000000000AB',
    '3x00000000000000000000FF',
    '1x00000000000000000000BB',
    '2x00000000000000000000BB',
    '2x00000000000000000000AA',
    ' 1x00000000000000000000AA ',
    '<TURNSTILE_SITE_KEY>',
  ]) {
    // Cloudflare's invisible always-block key ends in AB; the widget helper's
    // existing production test-key pattern must also refuse that credential.
    test(`refuses missing, test or placeholder site key ${JSON.stringify(key)}`, () => {
      const log = spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() =>
          checkProductionEnv({ ...roleEnv('accounts'), ACCOUNT_TURNSTILE_SITE_KEY: key }, [
            'accounts',
          ]),
        ).toThrow('ACCOUNT_TURNSTILE_SITE_KEY');
      } finally {
        log.mockRestore();
      }
    });
  }
  test('refuses local mode even with a site key and development NODE_ENV', () => {
    expect(() =>
      checkProductionEnv(
        { ...roleEnv('accounts'), NODE_ENV: 'development', ACCOUNT_TURNSTILE_MODE: 'local' },
        ['accounts'],
      ),
    ).toThrow('ACCOUNT_TURNSTILE_MODE');
  });
  test('accepts a production site key without an Account service secret', () => {
    expect(() => checkProductionEnv(roleEnv('accounts'), ['accounts'])).not.toThrow();
  });
});

describe('production safety responder configuration', () => {
  for (const missing of [
    ['SAFETY_PRIMARY_ACCOUNT', 'SAFETY_BACKUP_ACCOUNT'],
    ['SAFETY_PRIMARY_ACCOUNT'],
    ['SAFETY_BACKUP_ACCOUNT'],
    ['MAIN_RELAY_DATABASE_URL'],
    ['MAIN_RELAY_CONSUMER'],
  ]) {
    test(`reports exact missing safety operator inputs: ${missing.join(', ')}`, () => {
      const env = roleEnv('main');
      for (const name of missing) delete env[name];
      expect(() => checkProductionEnv(env, ['main'])).toThrow(
        `Production safety requires ${missing.join(', ')}`,
      );
    });
  }
  for (const primary of [
    '',
    ' ',
    'fixture-backup-subject',
    'TBD',
    'TODO',
    'UNSET',
    '<PRIMARY>',
    'with space',
    'with\nnewline',
    'a'.repeat(129),
  ]) {
    test(`refuses unsafe primary responder ${JSON.stringify(primary)}`, () => {
      expect(() =>
        checkProductionEnv({ ...roleEnv('main'), SAFETY_PRIMARY_ACCOUNT: primary }, ['main']),
      ).toThrow('SAFETY_PRIMARY_ACCOUNT');
    });
  }
  for (const backup of ['', ' ', 'fixture-primary-subject', 'TBD', 'with space']) {
    test(`refuses unsafe backup responder ${JSON.stringify(backup)}`, () => {
      expect(() =>
        checkProductionEnv({ ...roleEnv('main'), SAFETY_BACKUP_ACCOUNT: backup }, ['main']),
      ).toThrow('SAFETY_BACKUP_ACCOUNT');
    });
  }
  test('accepts distinct responder subjects and a retained relay', () => {
    expect(() => checkProductionEnv(roleEnv('main'), ['main'])).not.toThrow();
  });
  test('preserves required matcher mode validation', () => {
    for (const mode of ['none', 'provider']) {
      expect(() =>
        checkProductionEnv({ ...roleEnv('main'), MAIN_REQUIRED_MEDIA_MATCHER: mode }, ['main']),
      ).not.toThrow();
    }
    for (const mode of ['local:/srv/corpus.json', 'unknown']) {
      expect(() =>
        checkProductionEnv({ ...roleEnv('main'), MAIN_REQUIRED_MEDIA_MATCHER: mode }, ['main']),
      ).toThrow('MAIN_REQUIRED_MEDIA_MATCHER');
    }
  });
});

describe('production role isolation and error output', () => {
  for (const role of Object.keys(productionSpecs) as ProductionRole[]) {
    test(`${role} accepts only its role inputs`, () => {
      expect(() => checkProductionEnv(roleEnv(role), [role])).not.toThrow();
    });
  }
  test('unrelated roles do not require enrollment or safety configuration from a combined file', () => {
    const env: Record<string, string> = {
      ...productionExample(),
      ACCOUNT_TURNSTILE_MODE: 'local',
      ACCOUNT_TURNSTILE_SECRET_KEY: '',
      ACCOUNT_TURNSTILE_SITE_KEY: '',
      ACCOUNT_MAIL_EVENTS_SECRET: 'too-short',
      MAIN_REQUIRED_MEDIA_MATCHER: 'local:/srv/corpus.json',
    };
    delete env.SAFETY_PRIMARY_ACCOUNT;
    delete env.SAFETY_BACKUP_ACCOUNT;
    for (const role of ['relay', 'relay-init', 'migrate', 'web', 'about'] as const) {
      expect(() => checkProductionEnv(env, [role])).not.toThrow();
    }
  });
  for (const [role, name, value] of [
    ['account', 'ACCOUNT_SMTP_SECURE', 'private-credential-that-is-not-a-bool'],
    ['account', 'ACCOUNT_DATABASE_URL', 'private-credential-that-is-not-a-url'],
    ['account', 'ACCOUNT_MAIL_EVENTS_SECRET', 'private-short-secret'],
    ['main', 'SAFETY_BACKUP_ACCOUNT', 'private subject with spaces'],
    ['about', 'ACCOUNT_DATABASE_URL', 'private-credential-that-is-not-a-url'],
    [
      'account',
      'ACCOUNT_DATABASE_URL',
      'postgres://owner:private%zzcredential@postgres.internal/account',
    ],
  ] as const) {
    test(`redacts errors for ${name} in ${role}`, () => {
      const log = spyOn(console, 'error').mockImplementation(() => {});
      const exit = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('unexpected exit');
      });
      try {
        let failure: unknown;
        try {
          checkProductionEnv({ ...roleEnv(role), [name]: value }, [role]);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain(name);
        expect(inspect(failure)).not.toContain(value);
        expect(log).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
        exit.mockRestore();
      }
    });
  }
});
