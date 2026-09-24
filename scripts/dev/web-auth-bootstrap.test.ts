import { expect, test } from 'bun:test';
import { parseWebAuthOptions } from './web-auth-bootstrap.ts';

test('IAM01: local web auth bootstrap accepts only a disposable run and exact loopback callback', () => {
  expect(parseWebAuthOptions(['--run-id', 'web-demo', '--redirect-uri',
    'http://localhost:3000/auth/callback', '--redirect-uri',
    'http://127.0.0.1:3003/auth/callback'])).toEqual({
    runId: 'web-demo', redirectUris: ['http://localhost:3000/auth/callback',
      'http://127.0.0.1:3003/auth/callback'],
  });
  for (const redirect of [
    'https://localhost:3000/auth/callback', 'http://example.test:3000/auth/callback',
    'http://localhost.evil.test:3000/auth/callback', 'http://localhost/auth/callback',
    'http://localhost:3000/auth/callback?next=evil',
    'http://localhost:3000/auth/callback#fragment',
  ]) {
    expect(() => parseWebAuthOptions(['--run-id', 'web-demo', '--redirect-uri', redirect]))
      .toThrow();
  }
  expect(() => parseWebAuthOptions(['--run-id', '../dev', '--redirect-uri',
    'http://localhost:3000/auth/callback'])).toThrow();
});
