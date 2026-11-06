import { expect, test } from 'bun:test';
import { securityResponseByteBudgets, securityScopeLimit } from '@rezics/auth-contract';
import {
  parseSecurityResponseConfiguration,
  securityInventoryResponseByteBudget,
  securityIssuerCallerOrigin,
} from '../src/security-response-config';

test('issuer reads admit only the Auth origin, its issuer, or a same-origin navigation without Origin', () => {
  const origin = 'http://127.0.0.1:4200';
  const web = 'http://127.0.0.1:3000';
  const headers = (entries: Record<string, string>) => new Headers(entries);
  const cases: [Record<string, string>, string | null][] = [
    [{ origin, 'sec-fetch-site': 'same-origin' }, origin],
    [{ origin: 'http://localhost:4200', 'sec-fetch-site': 'same-origin' }, null],
    [{ origin: web, 'sec-fetch-site': 'same-site' }, null],
    [{ 'sec-fetch-site': 'none' }, origin],
    [{ 'sec-fetch-site': 'same-origin' }, origin],
    [{ 'sec-fetch-site': 'cross-site' }, null],
    [{ origin: web, 'sec-fetch-site': 'cross-site' }, null],
    [{}, null],
  ];
  for (const [entries, expected] of cases)
    expect(securityIssuerCallerOrigin(headers(entries), origin, origin)).toBe(expected);
  expect(securityIssuerCallerOrigin(headers({ origin: web }), origin, web)).toBe(web);
});

test('selected inventory and session budgets share the trusted native catalogue configuration', () => {
  for (const count of [3, 4, 512, 1203]) {
    const configuration = `catalogue:${count}`;
    const parsed = parseSecurityResponseConfiguration(configuration);
    expect(parsed).toEqual({ scopeLimit: count, sessionBytes: securityResponseByteBudgets(count, 20).session });
    expect(securityInventoryResponseByteBudget('clients', configuration)).toBe(
      securityResponseByteBudgets(count, 20).clients,
    );
    expect(securityInventoryResponseByteBudget('consents', configuration)).toBe(
      securityResponseByteBudgets(count, 20).consents,
    );
  }

  const fallbackLimit = securityScopeLimit();
  expect(parseSecurityResponseConfiguration('native-no-catalogue')).toEqual({
    scopeLimit: fallbackLimit,
    sessionBytes: securityResponseByteBudgets(fallbackLimit, 20).session,
  });
  expect(securityInventoryResponseByteBudget('clients', 'native-no-catalogue')).toBe(
    securityResponseByteBudgets(fallbackLimit, 20).clients,
  );
});

test('missing, malformed and overflowing trusted configuration refuses dependent reads', () => {
  for (const invalid of [
    undefined,
    null,
    '',
    '4',
    'catalogue:0',
    'catalogue:-1',
    'catalogue:1.5',
    'catalogue:4x',
    'catalogue:9007199254740991',
  ]) {
    expect(parseSecurityResponseConfiguration(invalid)).toBeNull();
    expect(securityInventoryResponseByteBudget('clients', invalid)).toBeNull();
  }
});

test('the Cloudflare worker receives the trusted composition value as a text binding', async () => {
  const script = `
    process.env.AUTH_SECURITY_SCOPE_CONFIGURATION = 'catalogue:1203';
    const { default: config } = await import('./apps/auth/cloudflare.config.ts');
    const binding = config.worker.env.AUTH_SECURITY_SCOPE_CONFIGURATION;
    if (binding.type !== 'text' || binding.value !== 'catalogue:1203') throw new Error('Worker binding mismatch');
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(await child.exited, output + error).toBe(0);
});
