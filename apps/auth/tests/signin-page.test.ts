import { expect, spyOn, test } from 'bun:test';
import { LoginAttempt } from '../src/login-attempt';
import {
  canContinueAsCurrentAccount,
  loadSignInPage,
  loadSignInPageForJourney,
  parseSignInPage,
} from '../src/signin-page';

const origin = 'https://auth.example.test';

function payload(account: string) {
  return {
    methods: { password: true, passkey: true },
    viewer: { kind: 'signed-in', account_id: account, email: `${account}@example.test` },
    continuation: { href: '/authorize?client_id=search', requires_sign_in: false },
  };
}

test('sign-in read sends only the route query and refuses an unsafe continuation', async () => {
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(payload('viewer-a')), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  try {
    const result = await loadSignInPage('client_id=search', origin);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') expect(canContinueAsCurrentAccount(result.page)).toBe(true);
    expect(request.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ query: 'client_id=search' }));
    expect(
      parseSignInPage(
        { ...payload('viewer-a'), continuation: { href: '//evil.example', requires_sign_in: false } },
        origin,
      ),
    ).toBeNull();
  } finally {
    request.mockRestore();
  }
});

test('failed reads stay unavailable and a replaced page drops its late account advice', async () => {
  const unavailable = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
  try {
    expect(await loadSignInPage('', origin)).toEqual({ kind: 'unavailable' });
  } finally {
    unavailable.mockRestore();
  }

  let releaseOld!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => {
    releaseOld = resolve;
  });
  const request = spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => oldResponse)
    .mockResolvedValueOnce(new Response(JSON.stringify(payload('viewer-b')), { status: 200 }));
  try {
    const attempt = new LoginAttempt();
    const oldRead = loadSignInPageForJourney('', origin, attempt);
    await Promise.resolve();
    const currentRead = await loadSignInPageForJourney('', origin, attempt);
    expect(currentRead?.kind).toBe('ready');
    if (currentRead?.kind === 'ready') expect(currentRead.page.viewer.account_id).toBe('viewer-b');
    releaseOld(new Response(JSON.stringify(payload('viewer-a')), { status: 200 }));
    expect(await oldRead).toBeNull();
  } finally {
    request.mockRestore();
  }
});

test('account choice retires old reads and dispatched work excludes review without an extra request', async () => {
  const response = Promise.withResolvers<Response>();
  const request = spyOn(globalThis, 'fetch').mockReturnValue(response.promise);
  try {
    const owner = new LoginAttempt();
    const oldRead = loadSignInPageForJourney('?scope=&scope=a%20b&state=%2f', origin, owner);
    expect(owner.choose()).toBe(true);
    const dispatched = owner.begin('password')!;
    expect(owner.choose()).toBe(false);
    expect(await loadSignInPageForJourney('', origin, owner)).toBeNull();
    response.resolve(Response.json(payload('old')));
    expect(await oldRead).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(dispatched.finish()).toBe(true);
  } finally {
    request.mockRestore();
  }
});
