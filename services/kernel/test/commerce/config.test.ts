import { expect, test } from 'bun:test';
import { ConfigError, readCommerceConfig } from '../../src/commerce/config.ts';
import { readConfig } from '../../src/server.ts';

const env = {
  STRIPE_SECRET_KEY: 'sk_test_configuration_secret',
  STRIPE_WEBHOOK_SECRETS: 'whsec_current,whsec_previous',
  STRIPE_MANAGED_PAYMENTS: 'false',
  CHECKOUT_SUCCESS_URL: 'https://web.example.test/checkout?session={CHECKOUT_SESSION_ID}',
  CHECKOUT_CANCEL_URL: 'https://web.example.test/checkout/cancel',
};

test('commerce configuration preserves checkout URLs and rotating secrets and configures the Stripe adapter', () => {
  expect(readCommerceConfig(env)).toEqual({
    stripe: { apiKey: env.STRIPE_SECRET_KEY, managedPayments: false },
    webhookSecrets: ['whsec_current', 'whsec_previous'],
    successUrl: env.CHECKOUT_SUCCESS_URL,
    cancelUrl: env.CHECKOUT_CANCEL_URL,
  });
  expect(
    readCommerceConfig({ ...env, STRIPE_MANAGED_PAYMENTS: 'true', STRIPE_API_HOST: 'http://127.0.0.1:4321' }).stripe,
  ).toEqual({ apiKey: env.STRIPE_SECRET_KEY, managedPayments: true, host: '127.0.0.1', port: 4321, protocol: 'http' });
  expect(readCommerceConfig({ ...env, STRIPE_API_HOST: 'https://stripe.example.test' }).stripe).toMatchObject({
    host: 'stripe.example.test',
    port: 443,
    protocol: 'https',
  });
});

test('missing and invalid configuration names the variable without printing its value or secrets', () => {
  const invalid: Record<string, (string | undefined)[]> = {
    STRIPE_SECRET_KEY: [undefined, '', ' ', 'not-a-secret-key', 'sk_test_secret\n'],
    STRIPE_WEBHOOK_SECRETS: [undefined, '', 'whsec_one,', ',whsec_two', 'wrong', 'whsec_one, wrong'],
    STRIPE_MANAGED_PAYMENTS: [undefined, '', 'TRUE', '1', 'false '],
    STRIPE_API_HOST: [
      '',
      'ftp://stripe.example.test',
      'http://user:password@localhost',
      'https://stripe.test/path',
      'https://stripe.test?q=1',
      'https://stripe.test/#fragment',
    ],
    CHECKOUT_SUCCESS_URL: [
      undefined,
      '',
      '/relative',
      'http://web.example.test',
      'https://user:password@web.example.test',
    ],
    CHECKOUT_CANCEL_URL: [undefined, '', '/relative', 'javascript:alert(1)', 'http://web.example.test'],
  };
  for (const [variable, values] of Object.entries(invalid)) {
    for (const value of values) {
      let error: unknown;
      try {
        readCommerceConfig({ ...env, [variable]: value });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toBe(`Invalid or missing ${variable}`);
      expect((error as Error).message).not.toContain(env.STRIPE_SECRET_KEY);
      expect((error as Error).message).not.toContain('whsec_');
    }
  }
});

test('server configuration requires and carries commerce configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/rezics',
    KERNEL_ROUTE_KEY: Buffer.alloc(32, 1).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 2).toString('base64url')}`,
  };
  expect(readConfig({ ...base, ...env }).commerce).toEqual(readCommerceConfig(env));
  expect(() => readConfig(base)).toThrow('STRIPE_SECRET_KEY');
});
