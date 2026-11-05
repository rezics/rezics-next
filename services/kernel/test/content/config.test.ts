import { afterEach, expect, test } from 'bun:test';
import { ConfigError } from '../../src/commerce/config.ts';
import { readContentConfig } from '../../src/content/config.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('content API can start without Turnstile credentials and anonymous admission remains closed', async () => {
  const config = readContentConfig({});
  expect(config.fetchConfig).toBeUndefined();
  expect(config.anonymousVerifier).toBeUndefined();
});

test('content configuration binds the real Siteverify transport to the report hostname and action', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    const form = new URLSearchParams(String(init?.body));
    expect(form.get('secret')).toBe('turnstile-private-fixture-secret');
    expect(form.get('response')).toBe('provider-one-use-token');
    return Response.json({ success: true, hostname: 'content.example.test', action: 'report' });
  }) as typeof fetch;

  const config = readContentConfig({
    CONTENT_TURNSTILE_SECRET: 'turnstile-private-fixture-secret',
    CONTENT_TURNSTILE_HOSTNAME: 'content.example.test',
    CONTENT_SOURCE_HOSTS: 'images.example.test,cdn.example.test',
  });
  expect(config.fetchConfig).toEqual({ allowedHosts: ['images.example.test', 'cdn.example.test'] });
  expect(readContentConfig({ CONTENT_SOURCE_HOSTS: 'lain.bgm.tv' }).fetchConfig).toEqual({
    allowedHosts: ['lain.bgm.tv'],
  });
  await expect(config.anonymousVerifier!.verify('provider-one-use-token')).resolves.toMatchObject({
    ok: true,
    hostname: 'content.example.test',
    action: 'report',
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  expect(calls[0]!.init?.method).toBe('POST');
});

test('partial or malformed content configuration fails with a variable name and never echoes secrets', () => {
  const secret = 'top-secret-turnstile-value';
  for (const env of [
    { CONTENT_TURNSTILE_SECRET: secret },
    { CONTENT_TURNSTILE_HOSTNAME: 'content.example.test' },
    { CONTENT_TURNSTILE_SECRET: secret, CONTENT_TURNSTILE_HOSTNAME: 'not an origin' },
    { CONTENT_SOURCE_HOSTS: 'images.example.test,*.example.test' },
    { CONTENT_SOURCE_HOSTS: 'images.example.test,images.example.test' },
  ]) {
    let failure: unknown;
    try {
      readContentConfig(env);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConfigError);
    expect(String(failure)).not.toContain(secret);
  }
});
