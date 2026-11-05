import { afterEach, expect, spyOn, test } from 'bun:test';
import * as browser from '@simplewebauthn/browser';
import { signInWithPasskey } from '../src/passkeys';
import { nativeSignInOptions, nativeSignInProof } from './sign-in-fixture';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('conditional and deliberate consumers share one admitted options request after conditional retirement', async () => {
  const options = Promise.withResolvers<Response>();
  const dispatched = Promise.withResolvers<void>();
  const requests: string[] = [];
  const authenticate = spyOn(browser, 'startAuthentication').mockResolvedValue({ id: 'assertion' } as never);
  globalThis.fetch = ((input, init) => {
    const path = String(input);
    requests.push(path);
    if (path === '/signin/passkey/options') {
      dispatched.resolve();
      return options.promise;
    }
    if (path === '/signin/passkey')
      return Promise.resolve(Response.json(nativeSignInProof(JSON.parse(String(init?.body)), 'pop')));
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;

  try {
    const conditional = signInWithPasskey({ autofill: true, isCurrent: () => false });
    const deliberate = signInWithPasskey();
    await dispatched.promise;
    expect(requests).toEqual(['/signin/passkey/options']);

    options.resolve(Response.json(nativeSignInOptions()));
    expect(await conditional).toEqual({ ok: false, reason: 'cancelled' });
    expect(await deliberate).toMatchObject({ ok: true });
    expect(authenticate).toHaveBeenCalledWith({ optionsJSON: nativeSignInOptions(), useBrowserAutofill: false });
    expect(requests).toEqual(['/signin/passkey/options', '/signin/passkey']);
  } finally {
    authenticate.mockRestore();
  }
});
