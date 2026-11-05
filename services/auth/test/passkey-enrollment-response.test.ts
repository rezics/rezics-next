import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { passkeyEnrollmentResponseBytes as budgets, parsePasskeyEnrollmentCreated } from '@rezics/auth-contract';
import { receiveRegistrationOptions, registrationInput } from '../src/passkeys';

const require = createRequire(import.meta.url);
const { generateRegistrationOptions } = require(
  require.resolve('@simplewebauthn/server', {
    paths: [require.resolve('@better-auth/passkey')],
  }),
) as { generateRegistrationOptions: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function nativeOptions() {
  return generateRegistrationOptions({
    rpID: 'rezics.com',
    rpName: 'REZICS',
    userName: '\u0000'.repeat(1024),
    userDisplayName: '\ud800'.repeat(1024),
    userID: new TextEncoder().encode('a'.repeat(32)),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: Array.from({ length: 32 }, (_, i) => ({
      id: 'A'.repeat(16384),
      ...(i === 0
        ? {}
        : { transports: i === 1 ? [''] : ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] }),
    })),
  });
}
function stream(data: Uint8Array, length?: string) {
  return new Response(
    new ReadableStream({
      start(c) {
        // Split inside multibyte UTF-8 as well as escaped labels.
        for (let start = 0; start < data.length; start += 101) c.enqueue(data.slice(start, start + 101));
        c.close();
      },
    }),
    { headers: length === undefined ? {} : { 'content-length': length } },
  );
}

test('real pinned producer maxima project completely with default and supported transports', async () => {
  const options = await nativeOptions();
  expect(bytes(options).length).toBeLessThanOrEqual(budgets.options);
  for (const length of [undefined, '1']) {
    const received = await receiveRegistrationOptions(stream(bytes(options), length));
    expect<unknown>(received).toEqual({
      ...options,
      excludeCredentials: (options.excludeCredentials as object[]).map((row, i) =>
        i === 1 ? { ...row, transports: [] } : row,
      ),
    });
    expect(received.authenticatorSelection.userVerification).toBe('required');
  }
  const label = registrationInput(
    { response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: 'a'.repeat(43) })).toString('base64url') } },
    undefined,
  ).name;
  expect(label).toBeNull();
  expect(
    parsePasskeyEnrollmentCreated({ id: 'exact-effect-id', name: label, created_at: new Date().toISOString() })?.name,
  ).toBeNull();
});

test('plugin overflow and invalid configured fields never publish partial options', async () => {
  const options = await nativeOptions();
  for (const override of [
    { timeout: 0 },
    { rp: { id: 'evil.test', name: 'REZICS' } },
    { rp: { id: 'rezics.com', name: 'Other' } },
    { user: { id: 'id', name: 'x'.repeat(1025), displayName: 'a' } },
    { authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' } },
    { extensions: { credProps: true, unknown: true } },
    { pubKeyCredParams: [{ alg: -7, type: 'public-key' }] },
    { excludeCredentials: Array(33).fill({ id: 'a', type: 'public-key' }) },
  ])
    await expect(receiveRegistrationOptions(Response.json({ ...options, ...override }))).rejects.toThrow();
  for (const length of [undefined, '1', String(budgets.options + 1)])
    await expect(
      receiveRegistrationOptions(stream(new Uint8Array(budgets.options + 1).fill(32), length)),
    ).rejects.toThrow();
});
