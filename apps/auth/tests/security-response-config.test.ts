import { expect, test } from 'bun:test';
import { securityResponseByteBudgets } from '@rezics/auth-contract';
import { securityInventoryResponseByteBudget } from '../src/security-response-config';

test('selected inventory budgets require an explicit native catalogue mode and retain native bounds', () => {
  for (const count of [3, 4, 512, 1203]) {
    const config = `catalogue:${count}`;
    expect(securityInventoryResponseByteBudget('clients', config)).toBe(securityResponseByteBudgets(count, 20).clients);
    expect(securityInventoryResponseByteBudget('consents', config)).toBe(
      securityResponseByteBudgets(count, 20).consents,
    );
  }
  expect(securityInventoryResponseByteBudget('clients', 'native-no-catalogue')).toBe(
    securityResponseByteBudgets(1000, 20).clients,
  );
  for (const invalid of [
    undefined,
    null,
    '',
    '1000',
    'catalogue:0',
    'catalogue:-1',
    'catalogue:1.5',
    'catalogue:9007199254740991',
  ])
    expect(securityInventoryResponseByteBudget('clients', invalid)).toBeNull();
});

test('the Cloudflare worker receives the deployment composition value as a text binding', async () => {
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
